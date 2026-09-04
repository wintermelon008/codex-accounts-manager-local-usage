import { randomUUID } from "node:crypto";
import { QuotaExhaustionError, SessionCancelledError } from "./providers.mjs";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "quota_exhausted"]);
const MAX_EVENTS = 512;

export class GatewaySessionManager {
  #sessions = new Map();
  #subscribers = new Map();
  #running = 0;
  #exhaustionBatch;
  #manualSwitchInFlight;
  #manualSwitchActive = false;
  #automaticSwitchInFlight;
  #eventSequence = 0;

  constructor({ provider, manager, workspaces, maxSessions = 4, now = () => Date.now(), idFactory = randomUUID }) {
    this.provider = provider;
    this.manager = manager;
    this.workspaces = workspaces;
    this.maxSessions = maxSessions;
    this.now = now;
    this.idFactory = idFactory;
  }

  create(input) {
    const mode = input?.mode;
    const message = normalizeMessage(input?.message);
    if (mode !== "research" && mode !== "develop") {
      throw new Error("mode must be research or develop");
    }
    const id = this.idFactory();
    const now = this.now();
    const turn = createTurn(this.idFactory, message, now);
    const session = {
      id,
      mode,
      message,
      project: optionalText(input?.project),
      context: input?.context && typeof input.context === "object" && !Array.isArray(input.context)
        ? structuredClone(input.context)
        : undefined,
      status: "queued",
      accountId: undefined,
      accountEmail: undefined,
      threadId: undefined,
      createdAt: now,
      updatedAt: now,
      events: [],
      turns: [turn],
      activeTurnId: turn.id,
      result: undefined,
      error: undefined,
      controller: undefined,
      cancelRequested: false,
      recoveryCount: 0,
      resumeThreadId: undefined,
      manualRecoveryRequested: false,
      attemptedAccountIds: new Set(),
      recoveryPending: false,
      interjectionRequested: false,
      interruptedTurnId: undefined,
      workspace: undefined,
      diff: ""
    };
    this.#sessions.set(id, session);
    this.#emit(session, { type: "session.created" });
    this.#drain();
    return this.get(id);
  }

  send(id, input) {
    const session = this.#sessions.get(id);
    if (!session) {
      throw sessionError("session not found", 404);
    }
    if (session.status === "queued" || session.status === "running" || session.recoveryPending) {
      throw sessionError("session is still running", 409);
    }

    const message = normalizeMessage(input?.message);
    const now = this.now();
    const turn = createTurn(this.idFactory, message, now);
    session.turns.push(turn);
    session.activeTurnId = turn.id;
    session.message = message;
    session.context = input?.context && typeof input.context === "object" && !Array.isArray(input.context)
      ? { ...(session.context ?? {}), ...structuredClone(input.context) }
      : session.context;
    session.status = "queued";
    session.updatedAt = now;
    session.result = undefined;
    session.error = undefined;
    session.cancelRequested = false;
    session.manualRecoveryRequested = false;
    session.recoveryPending = false;
    session.interjectionRequested = false;
    session.interruptedTurnId = undefined;
    session.resumeThreadId = session.threadId;
    if (this.#exhaustionBatch?.state === "failed") {
      this.#exhaustionBatch = undefined;
    }
    this.#emit(session, {
      type: "session.message_added",
      turnId: turn.id,
      turn: snapshotTurn(turn)
    });
    this.#drain();
    return this.get(id);
  }

  interject(id, input) {
    const session = this.#sessions.get(id);
    if (!session) {
      throw sessionError("session not found", 404);
    }
    if (session.status !== "running" || session.recoveryPending || !session.controller) {
      throw sessionError("session is not running", 409);
    }
    if (session.interjectionRequested) {
      throw sessionError("an interjection is already pending", 409);
    }

    const message = normalizeMessage(input?.message);
    const now = this.now();
    const interruptedTurn = currentTurn(session);
    const turn = createTurn(this.idFactory, message, now);
    session.turns.push(turn);
    session.activeTurnId = turn.id;
    session.message = message;
    session.context = input?.context && typeof input.context === "object" && !Array.isArray(input.context)
      ? { ...(session.context ?? {}), ...structuredClone(input.context) }
      : session.context;
    session.updatedAt = now;
    session.result = undefined;
    session.error = undefined;
    session.cancelRequested = false;
    session.manualRecoveryRequested = false;
    session.recoveryPending = false;
    session.interjectionRequested = true;
    session.interruptedTurnId = interruptedTurn?.id;
    session.resumeThreadId = session.threadId;
    this.#emit(session, {
      type: "session.message_added",
      turnId: turn.id,
      turn: snapshotTurn(turn),
      interject: true
    });
    this.#emit(session, {
      type: "session.interjection_requested",
      turnId: turn.id,
      resumeThreadId: session.resumeThreadId
    });
    session.controller.abort();
    return this.get(id);
  }

  get(id) {
    const session = this.#sessions.get(id);
    return session ? snapshot(session) : undefined;
  }

  list() {
    return [...this.#sessions.values()].map(snapshot).sort((left, right) => left.createdAt - right.createdAt);
  }

  remove(id) {
    const session = this.#sessions.get(id);
    if (!session) {
      return false;
    }
    if (!TERMINAL_STATUSES.has(session.status) || session.recoveryPending) {
      throw sessionError("session must be stopped before deletion", 409);
    }
    if (session.workspace?.status === "open") {
      throw sessionError("session has an open develop worktree; apply or discard it before deletion", 409);
    }
    this.#subscribers.delete(id);
    const batch = this.#exhaustionBatch;
    if (batch) {
      batch.sessionIds.delete(id);
      batch.quotaSessionIds.delete(id);
      if (batch.sessionIds.size === 0) {
        this.#exhaustionBatch = undefined;
      }
    }
    this.#sessions.delete(id);
    return true;
  }

  getEvents(id) {
    const session = this.#sessions.get(id);
    return session ? session.events.map((event) => structuredClone(event)) : undefined;
  }

  subscribe(id, listener) {
    if (!this.#sessions.has(id)) {
      return () => undefined;
    }
    const listeners = this.#subscribers.get(id) ?? new Set();
    listeners.add(listener);
    this.#subscribers.set(id, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.#subscribers.delete(id);
      }
    };
  }

  cancel(id) {
    const session = this.#sessions.get(id);
    if (!session) {
      return undefined;
    }
    if (TERMINAL_STATUSES.has(session.status)) {
      return snapshot(session);
    }
    session.interjectionRequested = false;
    session.cancelRequested = true;
    if (session.status === "queued") {
      this.#finish(session, "cancelled", { code: "cancelled", message: "Session cancelled before start" });
    } else {
      session.controller?.abort();
      this.#emit(session, { type: "session.cancel_requested" });
    }
    return snapshot(session);
  }

  async apply(id) {
    return this.#updateWorkspace(id, "apply");
  }

  async discard(id) {
    return this.#updateWorkspace(id, "discard");
  }

  manualSwitch(accountId) {
    if (this.#manualSwitchInFlight) {
      return this.#manualSwitchInFlight;
    }
    if (!this.manager || typeof this.manager.switchAccount !== "function") {
      return Promise.reject(new Error("Manager account switching is unavailable"));
    }
    this.#manualSwitchActive = true;
    const automaticSwitch = this.#automaticSwitchInFlight;
    const existingBatch = this.#exhaustionBatch;
    const active = [...this.#sessions.values()].filter((session) => session.status === "running");
    const batchRecovery = this.#exhaustionBatch
      ? [...this.#exhaustionBatch.quotaSessionIds]
          .map((id) => this.#sessions.get(id))
          .filter((session) => session && session.status === "quota_exhausted")
      : [];
    const candidates = new Map([...batchRecovery, ...active].map((session) => [session.id, session]));
    const attempt = (async () => {
      for (const session of active) {
        session.interjectionRequested = false;
        session.manualRecoveryRequested = true;
        session.cancelRequested = true;
        session.controller?.abort();
        this.#emit(session, { type: "session.manual_interrupt_requested" });
      }
      await Promise.all(active.map((session) => this.waitForTerminal(session.id)));
      if (automaticSwitch) {
        await automaticSwitch.catch(() => undefined);
      }

      let outcome;
      try {
        outcome = await this.manager.switchAccount(accountId, { force: true });
      } catch (error) {
        this.#markRecoveryFailure(existingBatch, error);
        throw error;
      }
      if (outcome?.status !== "switched") {
        const error = new Error(outcome?.message ?? "Manager account switch failed");
        this.#markRecoveryFailure(existingBatch, error);
        throw error;
      }
      this.#exhaustionBatch = undefined;

      for (const session of candidates.values()) {
        if (session.status === "cancelled" || session.status === "quota_exhausted") {
          session.attemptedAccountIds = new Set([outcome.accountId ?? accountId]);
          this.#queueRecovery(session, outcome.accountId ?? accountId, outcome.email);
        }
      }
      this.#drain();
      return {
        status: "switched",
        accountId: outcome.accountId ?? accountId,
        recoveredSessionIds: [...candidates.values()]
          .filter((session) => session.status === "queued")
          .map((session) => session.id)
      };
    })();
    this.#manualSwitchInFlight = attempt;
    return attempt.finally(() => {
      if (this.#manualSwitchInFlight === attempt) {
        this.#manualSwitchInFlight = undefined;
      }
      this.#manualSwitchActive = false;
      this.#drain();
    });
  }

  getRecoveryStatus() {
    const batch = this.#exhaustionBatch;
    if (!batch) {
      return { state: "idle" };
    }
    return {
      state: batch.state,
      accountId: batch.accountId,
      sessionIds: [...batch.sessionIds],
      quotaSessionIds: [...batch.quotaSessionIds],
      startedAt: batch.startedAt,
      targetAccountId: batch.targetAccountId,
      error: batch.error
    };
  }

  canSwitchAccounts() {
    return Boolean(this.manager && typeof this.manager.switchAccount === "function");
  }

  hasWorktreeSupport() {
    return Boolean(
      this.workspaces &&
      typeof this.workspaces.prepare === "function" &&
      typeof this.workspaces.collectDiff === "function" &&
      typeof this.workspaces.apply === "function" &&
      typeof this.workspaces.discard === "function" &&
      (typeof this.workspaces.isAvailable !== "function" || this.workspaces.isAvailable())
    );
  }

  isRecoveryPending(id) {
    return this.#sessions.get(id)?.recoveryPending === true;
  }

  async waitForTerminal(id, timeoutMs = 10_000) {
    const current = this.#sessions.get(id);
    if (!current) {
      throw new Error("session not found");
    }
    if (TERMINAL_STATUSES.has(current.status)) {
      return snapshot(current);
    }
    return new Promise((resolve, reject) => {
      let unsubscribe = () => undefined;
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error("session did not reach a terminal state before timeout"));
      }, timeoutMs);
      unsubscribe = this.subscribe(id, () => {
        const session = this.#sessions.get(id);
        if (!session || !TERMINAL_STATUSES.has(session.status)) {
          return;
        }
        clearTimeout(timer);
        unsubscribe();
        resolve(snapshot(session));
      });
      const afterSubscribe = this.#sessions.get(id);
      if (afterSubscribe && TERMINAL_STATUSES.has(afterSubscribe.status)) {
        clearTimeout(timer);
        unsubscribe();
        resolve(snapshot(afterSubscribe));
      }
    });
  }

  #drain() {
    if (this.#manualSwitchActive || this.#manualSwitchInFlight || (this.#exhaustionBatch && this.#exhaustionBatch.state !== "ready")) {
      return;
    }
    while (this.#running < this.maxSessions) {
      const next = [...this.#sessions.values()].find((session) => session.status === "queued");
      if (!next) {
        return;
      }
      this.#running += 1;
      void this.#run(next).finally(() => {
        this.#running -= 1;
        void this.#maybeSettleExhaustionBatch();
        this.#drain();
      });
    }
  }

  async #run(session) {
    session.status = "running";
    session.updatedAt = this.now();
    session.controller = new AbortController();
    const turn = currentTurn(session);
    if (turn) {
      turn.status = "running";
      turn.updatedAt = session.updatedAt;
    }
    try {
      if (this.manager) {
        const account = await this.manager.getActiveAccount();
        session.accountId = account.id;
        session.accountEmail = account.email;
        session.attemptedAccountIds.add(account.id);
      }
      if (session.mode === "develop" && this.workspaces && !session.workspace) {
        session.workspace = await this.workspaces.prepare(session);
      }
      if (session.interjectionRequested || session.controller.signal.aborted) {
        await this.#refreshWorkspace(session);
        if (session.interjectionRequested) {
          this.#queueInterjection(session, turn);
        } else {
          this.#finish(session, "cancelled", { code: "cancelled", message: "Session cancelled" });
        }
        return;
      }
      this.#emit(session, { type: "session.started", accountId: session.accountId, accountEmail: session.accountEmail });
      const result = await this.provider.run({
        session: providerSnapshot(session),
        signal: session.controller.signal,
        emit: (event) => this.#emit(session, event)
      });
      if (session.interjectionRequested) {
        await this.#refreshWorkspace(session);
        this.#queueInterjection(session, turn);
        return;
      }
      if (session.cancelRequested || session.controller.signal.aborted) {
        await this.#refreshWorkspace(session);
        this.#finish(session, "cancelled", { code: "cancelled", message: "Session cancelled" });
        return;
      }
      await this.#refreshWorkspace(session);
      session.result = {
        text: typeof result?.text === "string" ? result.text : undefined,
        threadId: typeof result?.threadId === "string" ? result.threadId : undefined
      };
      if (turn) {
        turn.status = "completed";
        turn.updatedAt = this.now();
        turn.result = session.result;
        turn.error = undefined;
      }
      if (session.result.threadId) {
        session.threadId = session.result.threadId;
      }
      session.resumeThreadId = undefined;
      this.#finish(session, "completed");
    } catch (error) {
      if (session.interjectionRequested) {
        await this.#refreshWorkspace(session);
        this.#queueInterjection(session, turn);
        return;
      }
      if (error instanceof SessionCancelledError || session.cancelRequested || session.controller.signal.aborted) {
        await this.#refreshWorkspace(session);
        this.#finish(session, "cancelled", { code: "cancelled", message: error.message });
        return;
      }
      if (error instanceof QuotaExhaustionError || error?.code === "quota_exhausted") {
        if (typeof error?.threadId === "string") {
          session.threadId = error.threadId;
        }
        await this.#refreshWorkspace(session);
        this.#registerQuotaExhaustion(session);
        this.#finish(session, "quota_exhausted", { code: "quota_exhausted", message: error.message });
        return;
      }
      await this.#refreshWorkspace(session);
      this.#finish(session, "failed", {
        code: typeof error?.code === "string" ? error.code : "provider_error",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  #finish(session, status, error) {
    this.#markInterruptedTurn(session);
    session.status = status;
    session.error = error;
    session.controller = undefined;
    session.updatedAt = this.now();
    const turn = currentTurn(session);
    if (turn) {
      turn.status = status;
      turn.updatedAt = session.updatedAt;
      turn.error = error;
      if (status !== "completed") {
        turn.result = undefined;
      }
    }
    this.#emit(session, { type: "session.terminal", status, error, recoveryPending: session.recoveryPending });
  }

  #queueInterjection(session, interruptedTurn) {
    this.#markInterruptedTurn(session, interruptedTurn);
    session.status = "queued";
    session.error = undefined;
    session.result = undefined;
    session.controller = undefined;
    session.cancelRequested = false;
    session.manualRecoveryRequested = false;
    session.interjectionRequested = false;
    session.interruptedTurnId = undefined;
    session.resumeThreadId = session.threadId;
    const turn = currentTurn(session);
    if (turn) {
      turn.status = "queued";
      turn.updatedAt = this.now();
      turn.result = undefined;
      turn.error = undefined;
    }
    session.updatedAt = this.now();
    this.#emit(session, {
      type: "session.interjection_queued",
      turnId: turn?.id,
      resumeThreadId: session.resumeThreadId
    });
  }

  async #refreshWorkspace(session) {
    if (!session.workspace || !this.workspaces || session.workspace.status !== "open") {
      return;
    }
    try {
      session.diff = await this.workspaces.collectDiff(session.workspace);
      session.workspace = { ...session.workspace, diff: session.diff };
    } catch (error) {
      this.#emit(session, {
        type: "session.workspace_error",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async #updateWorkspace(id, action) {
    const session = this.#sessions.get(id);
    if (!session) {
      throw new Error("session not found");
    }
    if (!session.workspace || session.workspace.status !== "open") {
      throw new Error("session has no open develop worktree");
    }
    if (session.status === "running" || session.status === "queued") {
      throw new Error("session must be stopped before changing its worktree");
    }
    if (
      session.status === "quota_exhausted" &&
      this.#exhaustionBatch?.state !== "failed" &&
      this.#exhaustionBatch?.quotaSessionIds.has(id)
    ) {
      throw new Error("session is waiting for quota recovery");
    }
    if (!this.workspaces) {
      throw new Error("worktree management is unavailable");
    }
    session.workspace = action === "apply"
      ? await this.workspaces.apply(session.workspace)
      : await this.workspaces.discard(session.workspace);
    session.diff = "";
    this.#emit(session, {
      type: action === "apply" ? "session.workspace_applied" : "session.workspace_discarded",
      status: session.workspace.status
    });
    return snapshot(session);
  }

  #markRecoveryFailure(batch, error) {
    if (!batch || this.#exhaustionBatch !== batch) {
      return;
    }
    batch.state = "failed";
    batch.error = error instanceof Error ? error.message : String(error);
    for (const id of batch.sessionIds) {
      const session = this.#sessions.get(id);
      if (session) {
        session.recoveryPending = false;
        this.#emit(session, { type: "session.recovery_failed", message: batch.error });
      }
    }
  }

  #registerQuotaExhaustion(session) {
    if (!session.accountId) {
      return;
    }
    if (!this.#exhaustionBatch) {
      const sessionIds = [...this.#sessions.values()]
        .filter((candidate) => candidate.accountId === session.accountId && candidate.status === "running")
        .map((candidate) => candidate.id);
      if (!sessionIds.includes(session.id)) {
        sessionIds.push(session.id);
      }
      const attemptedAccountIds = new Set([session.accountId]);
      for (const id of sessionIds) {
        for (const accountId of this.#sessions.get(id)?.attemptedAccountIds ?? []) {
          attemptedAccountIds.add(accountId);
        }
      }
      this.#exhaustionBatch = {
        accountId: session.accountId,
        sessionIds: new Set(sessionIds),
        quotaSessionIds: new Set(),
        attemptedAccountIds,
        state: "draining",
        startedAt: this.now(),
        targetAccountId: undefined,
        error: undefined
      };
    }
    if (this.#exhaustionBatch.accountId !== session.accountId) {
      return;
    }
    session.recoveryPending = true;
    this.#exhaustionBatch.quotaSessionIds.add(session.id);
    for (const id of this.#exhaustionBatch.sessionIds) {
      const candidate = this.#sessions.get(id);
      if (candidate) {
        this.#emit(candidate, {
          type: "session.quota_batch_pending",
          accountId: this.#exhaustionBatch.accountId,
          quotaSessionId: session.id
        });
      }
    }
  }

  async #maybeSettleExhaustionBatch() {
    const batch = this.#exhaustionBatch;
    if (!batch || batch.state !== "draining" || this.#manualSwitchActive) {
      return;
    }
    const settled = [...batch.sessionIds].every((id) => {
      const session = this.#sessions.get(id);
      return !session || TERMINAL_STATUSES.has(session.status);
    });
    if (!settled) {
      return;
    }
    batch.state = "switching";
    try {
      const next = await this.#selectNextAccount(batch.accountId, batch.attemptedAccountIds);
      if (this.#manualSwitchActive || this.#exhaustionBatch !== batch) {
        return;
      }
      if (!next) {
        throw new Error("Manager 没有可用的下一个账号");
      }
      batch.targetAccountId = next.id;
      batch.attemptedAccountIds.add(next.id);
      const switchAttempt = this.manager.switchAccount(next.id, { force: false });
      this.#automaticSwitchInFlight = switchAttempt;
      let outcome;
      try {
        outcome = await switchAttempt;
      } finally {
        if (this.#automaticSwitchInFlight === switchAttempt) {
          this.#automaticSwitchInFlight = undefined;
        }
      }
      if (this.#manualSwitchActive || this.#exhaustionBatch !== batch) {
        return;
      }
      if (outcome?.status !== "switched") {
        throw new Error(outcome?.message ?? "Manager automatic account switch failed");
      }
      batch.state = "recovering";
      for (const id of batch.quotaSessionIds) {
        const session = this.#sessions.get(id);
        if (session && session.status === "quota_exhausted") {
          this.#queueRecovery(session, outcome.accountId ?? next.id, outcome.email);
        }
      }
      batch.state = "ready";
      this.#exhaustionBatch = undefined;
      this.#drain();
    } catch (error) {
      this.#markRecoveryFailure(batch, error);
    }
  }

  async #selectNextAccount(currentAccountId, attemptedAccountIds = new Set()) {
    if (!this.manager || typeof this.manager.getAccounts !== "function") {
      throw new Error("Manager account directory is unavailable");
    }
    const body = await this.manager.getAccounts();
    const accounts = Array.isArray(body?.accounts) ? body.accounts : [];
    return accounts
      .filter((account) => {
        if (!account?.id || account.id === currentAccountId || attemptedAccountIds.has(account.id)) {
          return false;
        }
        if (account.accountKind === "sub2api" || account.isHidden === true || account.manualOnly === true || account.poolEligible === false) {
          return false;
        }
        if (account.isActive === true || account.providerActive === true) {
          return false;
        }
        return account.health === undefined || account.health === "healthy";
      })
      .sort((left, right) => quotaScore(right) - quotaScore(left))[0];
  }

  #queueRecovery(session, accountId, accountEmail) {
    session.status = "queued";
    session.error = undefined;
    session.result = undefined;
    session.cancelRequested = false;
    session.manualRecoveryRequested = false;
    session.recoveryPending = false;
    session.interjectionRequested = false;
    session.interruptedTurnId = undefined;
    session.recoveryCount += 1;
    session.resumeThreadId = session.threadId;
    session.accountId = accountId;
    session.accountEmail = accountEmail;
    session.attemptedAccountIds.add(accountId);
    session.updatedAt = this.now();
    const turn = currentTurn(session);
    if (turn) {
      turn.status = "queued";
      turn.updatedAt = session.updatedAt;
      turn.result = undefined;
      turn.error = undefined;
    }
    this.#emit(session, {
      type: "session.recovery_queued",
      accountId,
      recoveryCount: session.recoveryCount,
      resumeThreadId: session.resumeThreadId
    });
  }

  #emit(session, event) {
    const providerEvent = event?.event;
    if (providerEvent?.type === "thread.started" && typeof providerEvent.thread_id === "string") {
      session.threadId = providerEvent.thread_id;
    }
    const entry = {
      type: typeof event?.type === "string" ? event.type : "session.event",
      at: this.now(),
      ...(session.activeTurnId ? { turnId: session.activeTurnId } : {}),
      ...structuredClone(event ?? {}),
      eventId: ++this.#eventSequence
    };
    session.events.push(entry);
    if (session.events.length > MAX_EVENTS) {
      session.events.splice(0, session.events.length - MAX_EVENTS);
    }
    session.updatedAt = entry.at;
    const listeners = this.#subscribers.get(session.id);
    for (const listener of listeners ?? []) {
      try {
        listener(structuredClone(entry));
      } catch {
        // A disconnected event client must not break the session runner.
      }
    }
  }

  #markInterruptedTurn(session, fallbackTurn) {
    const id = session.interruptedTurnId;
    const turn = id
      ? session.turns.find((candidate) => candidate.id === id)
      : fallbackTurn;
    if (turn) {
      turn.status = "cancelled";
      turn.updatedAt = this.now();
      turn.error = undefined;
    }
    session.interruptedTurnId = undefined;
  }
}

function snapshot(session) {
  return {
    id: session.id,
    mode: session.mode,
    message: session.message,
    project: session.project,
    context: session.context,
    status: session.status,
    accountId: session.accountId,
    accountEmail: session.accountEmail,
    threadId: session.threadId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    turns: session.turns.map(snapshotTurn),
    activeTurnId: session.activeTurnId,
    result: session.result,
    error: session.error,
    recoveryCount: session.recoveryCount,
    recoveryPending: session.recoveryPending,
    interjectionPending: session.interjectionRequested,
    resumeThreadId: session.resumeThreadId,
    workspace: session.workspace
      ? {
          kind: session.workspace.kind,
          id: session.workspace.id,
          status: session.workspace.status,
          diff: session.diff
        }
      : undefined,
    diff: session.diff,
    events: session.events.map((event) => structuredClone(event))
  };
}

function snapshotTurn(turn) {
  return {
    id: turn.id,
    message: turn.message,
    status: turn.status,
    createdAt: turn.createdAt,
    updatedAt: turn.updatedAt,
    result: turn.result,
    error: turn.error
  };
}

function currentTurn(session) {
  return session.turns.find((turn) => turn.id === session.activeTurnId);
}

function createTurn(idFactory, message, now) {
  return {
    id: idFactory(),
    message,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    result: undefined,
    error: undefined
  };
}

function normalizeMessage(value) {
  const message = typeof value === "string" ? value.trim() : "";
  if (!message) {
    throw new Error("message is required");
  }
  if (message.length > 100_000) {
    throw new Error("message is too long");
  }
  return message;
}

function sessionError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function providerSnapshot(session) {
  return {
    ...snapshot(session),
    workspace: session.workspace ? structuredClone(session.workspace) : undefined
  };
}

function quotaScore(account) {
  const hourly = account?.quota?.hourly?.percentage;
  const weekly = account?.quota?.weekly?.percentage;
  const hourlyScore = typeof hourly === "number" ? hourly : -1;
  const weeklyScore = typeof weekly === "number" ? weekly : -1;
  return hourlyScore * 1_000_000 + weeklyScore;
}

function optionalText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

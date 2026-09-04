import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { QuotaExhaustionError } from "../src/providers.mjs";
import { GatewaySessionManager } from "../src/session-manager.mjs";

describe("GatewaySessionManager", () => {
  it("runs independent sessions in parallel up to the configured limit", async () => {
    const started = [];
    const provider = {
      async run({ session, emit }) {
        started.push(session.id);
        emit({ type: "provider.delta", text: session.message });
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { text: `done:${session.message}`, threadId: `thread-${session.id}` };
      }
    };
    const manager = {
      async getActiveAccount() {
        return { id: "account-a", email: "a@example.com" };
      }
    };
    const sessions = new GatewaySessionManager({ provider, manager, maxSessions: 2 });
    const first = sessions.create({ mode: "research", message: "one" });
    const second = sessions.create({ mode: "develop", message: "two" });
    await Promise.all([sessions.waitForTerminal(first.id), sessions.waitForTerminal(second.id)]);

    assert.equal(started.length, 2);
    assert.equal(sessions.get(first.id)?.status, "completed");
    assert.equal(sessions.get(first.id)?.accountId, "account-a");
    assert.equal(sessions.get(first.id)?.result?.text, "done:one");
    assert.equal(sessions.get(second.id)?.status, "completed");
    assert.equal(sessions.get(second.id)?.accountId, "account-a");
  });

  it("cancels a queued session without starting its provider", async () => {
    let calls = 0;
    const provider = {
      async run() {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { text: "done" };
      }
    };
    const sessions = new GatewaySessionManager({ provider, maxSessions: 1 });
    const first = sessions.create({ mode: "research", message: "first" });
    const second = sessions.create({ mode: "research", message: "second" });
    sessions.cancel(second.id);
    await sessions.waitForTerminal(first.id);

    assert.equal(calls, 1);
    assert.equal(sessions.get(second.id)?.status, "cancelled");
    assert.equal(sessions.get(second.id)?.error?.code, "cancelled");
  });

  it("keeps follow-up messages in one session and resumes its conversation", async () => {
    const seen = [];
    const provider = {
      async run({ session }) {
        seen.push({ messages: session.turns?.map((turn) => turn.message), resumeThreadId: session.resumeThreadId });
        return {
          text: `answer:${session.message}`,
          threadId: session.threadId ?? `thread-${seen.length}`
        };
      }
    };
    const sessions = new GatewaySessionManager({ provider, maxSessions: 1 });
    const session = sessions.create({ mode: "research", message: "第一问" });
    await sessions.waitForTerminal(session.id);

    sessions.send(session.id, { message: "第二问" });
    await sessions.waitForTerminal(session.id);

    const snapshot = sessions.get(session.id);
    assert.equal(snapshot?.turns.length, 2);
    assert.deepEqual(snapshot?.turns.map((turn) => turn.message), ["第一问", "第二问"]);
    assert.deepEqual(seen[1], { messages: ["第一问", "第二问"], resumeThreadId: "thread-1" });
    assert.equal(snapshot?.result?.text, "answer:第二问");
  });

  it("interjects a running session and resumes the same Codex thread", async () => {
    const seen = [];
    let resolveStarted;
    const started = new Promise((resolve) => {
      resolveStarted = resolve;
    });
    const provider = {
      async run({ session, signal, emit }) {
        seen.push({ message: session.message, resumeThreadId: session.resumeThreadId });
        if (seen.length === 1) {
          emit({ type: "codex.event", event: { type: "thread.started", thread_id: "interject-thread" } });
          resolveStarted();
          await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
          return { text: "原任务的尾部不应覆盖插嘴" };
        }
        return { text: "已按插嘴指令继续", threadId: "interject-thread" };
      }
    };
    const sessions = new GatewaySessionManager({ provider, maxSessions: 1 });
    const session = sessions.create({ mode: "develop", message: "先执行原任务" });
    await started;

    const interjected = sessions.interject(session.id, { message: "改用这个方向继续" });
    assert.equal(interjected?.status, "running");
    assert.equal(interjected?.turns.length, 2);
    await sessions.waitForTerminal(session.id);

    const completed = sessions.get(session.id);
    assert.equal(completed?.status, "completed");
    assert.deepEqual(completed?.turns.map((turn) => turn.message), ["先执行原任务", "改用这个方向继续"]);
    assert.equal(completed?.turns[0]?.status, "cancelled");
    assert.equal(completed?.turns[1]?.result?.text, "已按插嘴指令继续");
    assert.deepEqual(seen, [
      { message: "先执行原任务", resumeThreadId: undefined },
      { message: "改用这个方向继续", resumeThreadId: "interject-thread" }
    ]);
    assert.equal(completed?.events.some((event) => event.type === "session.interjection_requested"), true);
    assert.equal(completed?.events.some((event) => event.type === "session.interjection_queued"), true);
  });

  it("removes completed sessions without affecting other sessions", async () => {
    const provider = {
      async run({ session }) {
        return { text: `done:${session.message}` };
      }
    };
    const sessions = new GatewaySessionManager({ provider });
    const first = sessions.create({ mode: "research", message: "remove me" });
    const second = sessions.create({ mode: "research", message: "keep me" });
    await Promise.all([sessions.waitForTerminal(first.id), sessions.waitForTerminal(second.id)]);

    assert.equal(sessions.remove(first.id), true);
    assert.equal(sessions.get(first.id), undefined);
    assert.equal(sessions.remove(first.id), false);
    assert.equal(sessions.get(second.id)?.status, "completed");
  });

  it("waits for the whole quota batch, switches once, and resumes quota sessions", async () => {
    const initialStarts = [];
    let resolveInitialStarts;
    const initialStartsReady = new Promise((resolve) => {
      resolveInitialStarts = resolve;
    });
    let activeAccountId = "account-a";
    const switches = [];
    const provider = {
      async run({ session }) {
        initialStarts.push(session);
        if (initialStarts.filter((candidate) => candidate.recoveryCount === 0).length === 2) {
          resolveInitialStarts();
        }
        if (session.recoveryCount === 0) {
          await initialStartsReady;
          throw new QuotaExhaustionError("quota reached", { threadId: `thread-${session.id}` });
        }
        return { text: `recovered:${session.id}`, threadId: `recovered-${session.id}` };
      }
    };
    const manager = {
      async getActiveAccount() {
        return { id: activeAccountId, email: `${activeAccountId}@example.com` };
      },
      async getAccounts() {
        return {
          accounts: [
            { id: "account-a", isActive: activeAccountId === "account-a", health: "healthy" },
            {
              id: "account-b",
              isActive: activeAccountId === "account-b",
              health: "healthy",
              quota: { hourly: { percentage: 90 }, weekly: { percentage: 80 } }
            }
          ]
        };
      },
      async switchAccount(accountId, options) {
        switches.push({ accountId, options });
        activeAccountId = accountId;
        return { status: "switched", accountId, email: `${accountId}@example.com` };
      }
    };
    const sessions = new GatewaySessionManager({ provider, manager, maxSessions: 2 });
    const first = sessions.create({ mode: "research", message: "one" });
    const second = sessions.create({ mode: "develop", message: "two" });

    await waitUntil(() => sessions.get(first.id)?.status === "completed" && sessions.get(second.id)?.status === "completed");

    assert.deepEqual(switches, [{ accountId: "account-b", options: { force: false } }]);
    for (const session of [sessions.get(first.id), sessions.get(second.id)]) {
      assert.equal(session?.status, "completed");
      assert.equal(session?.accountId, "account-b");
      assert.equal(session?.recoveryCount, 1);
      assert.equal(session?.result?.text, `recovered:${session.id}`);
      assert.ok(session?.events.some((event) => event.type === "session.recovery_queued"));
    }
    assert.equal(sessions.getRecoveryStatus().state, "idle");
    assert.equal(initialStarts.length, 4);
    assert.ok(initialStarts.slice(2).every((session) => typeof session.resumeThreadId === "string"));
  });

  it("recovers only the sessions that actually exhausted quota", async () => {
    let activeAccountId = "account-a";
    const switches = [];
    let initialRuns = 0;
    const provider = {
      async run({ session }) {
        if (session.recoveryCount === 0) {
          initialRuns += 1;
          if (initialRuns === 1) {
            throw new QuotaExhaustionError("quota reached", { threadId: `quota-${session.id}` });
          }
          return { text: "finished before quota" };
        }
        return { text: "quota session recovered" };
      }
    };
    const manager = {
      async getActiveAccount() {
        return { id: activeAccountId, email: `${activeAccountId}@example.com` };
      },
      async getAccounts() {
        return {
          accounts: [
            { id: "account-a", isActive: activeAccountId === "account-a", health: "healthy" },
            { id: "account-b", isActive: activeAccountId === "account-b", health: "healthy", quota: { hourly: { percentage: 90 } } }
          ]
        };
      },
      async switchAccount(accountId, options) {
        switches.push({ accountId, options });
        activeAccountId = accountId;
        return { status: "switched", accountId, email: `${accountId}@example.com` };
      }
    };
    const sessions = new GatewaySessionManager({ provider, manager, maxSessions: 2 });
    const exhausted = sessions.create({ mode: "research", message: "will exhaust" });
    const successful = sessions.create({ mode: "research", message: "will finish" });

    await waitUntil(() => sessions.get(exhausted.id)?.status === "completed" && sessions.get(successful.id)?.status === "completed");

    assert.deepEqual(switches, [{ accountId: "account-b", options: { force: false } }]);
    assert.equal(sessions.get(exhausted.id)?.recoveryCount, 1);
    assert.equal(sessions.get(successful.id)?.recoveryCount, 0);
    assert.equal(sessions.get(successful.id)?.result?.text, "finished before quota");
  });

  it("force-interrupts active sessions, switches, and resumes them on a manual switch", async () => {
    let activeAccountId = "account-a";
    let runCount = 0;
    let resolveStarted;
    const started = new Promise((resolve) => {
      resolveStarted = resolve;
    });
    const switches = [];
    const provider = {
      async run({ signal, emit }) {
        runCount += 1;
        if (runCount === 1) {
          emit({ type: "codex.event", event: { type: "thread.started", thread_id: "manual-thread" } });
          resolveStarted();
          await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
          return { text: "discarded" };
        }
        return { text: "manual recovery", threadId: "manual-thread-recovered" };
      }
    };
    const manager = {
      async getActiveAccount() {
        return { id: activeAccountId, email: `${activeAccountId}@example.com` };
      },
      async switchAccount(accountId, options) {
        switches.push({ accountId, options });
        activeAccountId = accountId;
        return { status: "switched", accountId, email: `${accountId}@example.com` };
      }
    };
    const sessions = new GatewaySessionManager({ provider, manager, maxSessions: 1 });
    const session = sessions.create({ mode: "develop", message: "continue this task" });
    await started;

    const outcome = await sessions.manualSwitch("account-b");
    await sessions.waitForTerminal(session.id);

    assert.deepEqual(switches, [{ accountId: "account-b", options: { force: true } }]);
    assert.deepEqual(outcome.recoveredSessionIds, [session.id]);
    assert.equal(sessions.get(session.id)?.status, "completed");
    assert.equal(sessions.get(session.id)?.accountId, "account-b");
    assert.equal(sessions.get(session.id)?.recoveryCount, 1);
    assert.equal(sessions.get(session.id)?.events.some((event) => event.type === "session.manual_interrupt_requested"), true);
    assert.equal(sessions.get(session.id)?.events.some((event) => event.type === "session.recovery_queued"), true);
    assert.equal(sessions.get(session.id)?.events.find((event) => event.type === "session.recovery_queued")?.resumeThreadId, "manual-thread");
    assert.equal(sessions.getRecoveryStatus().state, "idle");
  });

  it("stops automatic recovery after every eligible account has been tried", async () => {
    let activeAccountId = "account-a";
    const switches = [];
    const sessions = new GatewaySessionManager({
      maxSessions: 1,
      provider: {
        async run() {
          throw new QuotaExhaustionError("quota reached", { threadId: "exhausted-thread" });
        }
      },
      manager: {
        async getActiveAccount() {
          return { id: activeAccountId, email: `${activeAccountId}@example.com` };
        },
        async getAccounts() {
          return {
            accounts: [
              { id: "account-a", isActive: activeAccountId === "account-a", health: "healthy" },
              { id: "account-b", isActive: activeAccountId === "account-b", health: "healthy" }
            ]
          };
        },
        async switchAccount(accountId, options) {
          switches.push({ accountId, options });
          activeAccountId = accountId;
          return { status: "switched", accountId, email: `${accountId}@example.com` };
        }
      }
    });
    const session = sessions.create({ mode: "research", message: "exhaust every account" });

    await waitUntil(() => sessions.getRecoveryStatus().state === "failed");

    assert.deepEqual(switches, [{ accountId: "account-b", options: { force: false } }]);
    assert.equal(sessions.get(session.id)?.status, "quota_exhausted");
    assert.equal(sessions.get(session.id)?.recoveryCount, 1);
    assert.equal(sessions.get(session.id)?.events.some((event) => event.type === "session.recovery_failed"), true);
  });

  it("lets a manual switch take over an in-flight automatic switch without losing recovery", async () => {
    let activeAccountId = "account-a";
    let resolveAutomatic;
    const automaticSwitch = new Promise((resolve) => {
      resolveAutomatic = resolve;
    });
    const switches = [];
    let runCount = 0;
    const sessions = new GatewaySessionManager({
      maxSessions: 1,
      provider: {
        async run() {
          runCount += 1;
          if (runCount === 1) {
            throw new QuotaExhaustionError("quota reached", { threadId: "race-thread" });
          }
          return { text: "recovered after manual takeover", threadId: "race-thread-recovered" };
        }
      },
      manager: {
        async getActiveAccount() {
          return { id: activeAccountId, email: `${activeAccountId}@example.com` };
        },
        async getAccounts() {
          return {
            accounts: [
              { id: "account-a", isActive: activeAccountId === "account-a", health: "healthy" },
              { id: "account-b", isActive: activeAccountId === "account-b", health: "healthy", quota: { hourly: { percentage: 90 } } },
              { id: "account-c", isActive: activeAccountId === "account-c", health: "healthy", quota: { hourly: { percentage: 80 } } }
            ]
          };
        },
        async switchAccount(accountId, options) {
          switches.push({ accountId, options });
          if (options?.force === false) {
            await automaticSwitch;
          }
          activeAccountId = accountId;
          return { status: "switched", accountId, email: `${accountId}@example.com` };
        }
      }
    });
    const session = sessions.create({ mode: "develop", message: "race the switch" });

    await waitUntil(() => sessions.getRecoveryStatus().state === "switching");
    const manual = sessions.manualSwitch("account-c");
    await waitUntil(() => switches.length === 1);
    resolveAutomatic({ status: "switched", accountId: "account-b", email: "account-b@example.com" });
    await manual;
    await sessions.waitForTerminal(session.id);

    assert.deepEqual(switches, [
      { accountId: "account-b", options: { force: false } },
      { accountId: "account-c", options: { force: true } }
    ]);
    assert.equal(sessions.get(session.id)?.status, "completed");
    assert.equal(sessions.get(session.id)?.accountId, "account-c");
    assert.equal(sessions.getRecoveryStatus().state, "idle");
  });

  it("keeps the batch failed when Manager rejects the automatic switch", async () => {
    const sessions = new GatewaySessionManager({
      maxSessions: 1,
      provider: {
        async run() {
          throw new QuotaExhaustionError("quota reached");
        }
      },
      manager: {
        async getActiveAccount() {
          return { id: "account-a", email: "a@example.com" };
        },
        async getAccounts() {
          return { accounts: [{ id: "account-b", isActive: false, health: "healthy" }] };
        },
        async switchAccount() {
          return { status: "failed", message: "runtime switch unavailable" };
        }
      }
    });
    const session = sessions.create({ mode: "research", message: "switch failure" });

    await waitUntil(() => sessions.getRecoveryStatus().state === "failed");

    assert.equal(sessions.get(session.id)?.status, "quota_exhausted");
    assert.equal(sessions.get(session.id)?.recoveryPending, false);
    assert.equal(sessions.getRecoveryStatus().error, "runtime switch unavailable");
    assert.equal(sessions.get(session.id)?.events.some((event) => event.type === "session.recovery_failed"), true);
  });

  it("skips hidden, manual-only, and non-pool accounts during automatic recovery", async () => {
    let activeAccountId = "account-a";
    const switches = [];
    let runs = 0;
    const sessions = new GatewaySessionManager({
      maxSessions: 1,
      provider: {
        async run() {
          runs += 1;
          if (runs === 1) throw new QuotaExhaustionError("quota reached", { threadId: "eligible-thread" });
          return { text: "recovered" };
        }
      },
      manager: {
        async getActiveAccount() {
          return { id: activeAccountId, email: `${activeAccountId}@example.com` };
        },
        async getAccounts() {
          return {
            accounts: [
              { id: "account-a", isActive: activeAccountId === "account-a", health: "healthy", poolEligible: true },
              { id: "hidden-b", isActive: false, isHidden: true, health: "healthy", poolEligible: true, quota: { hourly: { percentage: 99 } } },
              { id: "manual-c", isActive: false, manualOnly: true, health: "healthy", poolEligible: true, quota: { hourly: { percentage: 98 } } },
              { id: "disabled-d", isActive: false, health: "healthy", poolEligible: false, quota: { hourly: { percentage: 97 } } },
              { id: "eligible-e", isActive: false, health: "healthy", poolEligible: true, quota: { hourly: { percentage: 1 } } }
            ]
          };
        },
        async switchAccount(accountId, options) {
          switches.push({ accountId, options });
          activeAccountId = accountId;
          return { status: "switched", accountId, email: `${accountId}@example.com` };
        }
      }
    });
    const session = sessions.create({ mode: "research", message: "choose an eligible fallback" });

    await waitUntil(() => sessions.get(session.id)?.status === "completed");

    assert.deepEqual(switches, [{ accountId: "eligible-e", options: { force: false } }]);
    assert.equal(sessions.get(session.id)?.status, "completed");
  });

  it("assigns distinct event ids to repeated provider events", async () => {
    const sessions = new GatewaySessionManager({
      provider: {
        async run({ emit }) {
          emit({ type: "provider.delta", text: "same" });
          emit({ type: "provider.delta", text: "same" });
          return { text: "same" };
        }
      }
    });
    const session = sessions.create({ mode: "research", message: "duplicate event test" });
    await sessions.waitForTerminal(session.id);

    const repeated = sessions.getEvents(session.id)?.filter((event) => event.type === "provider.delta") ?? [];
    assert.equal(repeated.length, 2);
    assert.notEqual(repeated[0].eventId, repeated[1].eventId);
  });
});

async function waitUntil(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition did not become true before timeout");
}

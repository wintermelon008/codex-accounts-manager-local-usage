"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  RegistrationEmailCodeWatcher,
  findLatestRecentEmailCode
} = require("../../src/operations/registration-email-code.cjs");

test("registration email code selection keeps only timestamped codes from the last 30 minutes", () => {
  const now = Date.parse("2026-08-20T12:00:00.000Z");
  const latest = findLatestRecentEmailCode([
    { receivedAt: "2026-08-20T11:10:00.000Z", codes: ["111111"], subject: "old" },
    { receivedAt: "2026-08-20T11:45:00.000Z", codes: ["222222"], subject: "older recent" },
    { receivedAt: "2026-08-20T11:59:00.000Z", codes: ["333333"], subject: "latest" },
    { receivedAt: undefined, codes: ["444444"], subject: "unknown time" },
    { receivedAt: "2026-08-20T12:01:00.000Z", codes: ["555555"], subject: "future" }
  ], now);

  assert.deepEqual(latest, {
    code: "333333",
    receivedAt: "2026-08-20T11:59:00.000Z",
    subject: "latest"
  });
});

test("registration email watcher queries the matching imported provider and exposes the newest code", async () => {
  let now = Date.parse("2026-08-20T12:00:00.000Z");
  let queryCount = 0;
  const recorded = [];
  const states = [];
  const account = { id: "mailbox-1", providerId: "mock", address: "person@example.com", credentials: { token: "opaque" } };
  const provider = {
    apiVersion: 1,
    id: "mock",
    capabilities: { history: "latest", maxMessages: 1 },
    parseImport: () => ({ entries: [], failed: [] }),
    async query() {
      queryCount += 1;
      return {
        ok: true,
        providerId: "mock",
        messages: queryCount === 1
          ? []
          : [{ receivedAt: new Date(now).toISOString(), codes: ["654321"], subject: "OpenAI code" }],
        codes: queryCount === 1 ? [] : ["654321"]
      };
    }
  };
  const watcher = new RegistrationEmailCodeWatcher({
    pool: {
      listMetadata: () => [{ id: account.id, providerId: account.providerId, address: account.address, enabled: true }],
      getAccount: async () => account,
      recordQueryResult: async (id, result) => recorded.push({ id, result })
    },
    providers: { get: (id) => id === provider.id ? provider : undefined },
    now: () => now,
    sleep: async (milliseconds) => { now += milliseconds; },
    pollMs: 10,
    windowMs: 100,
    onStateChange: (state) => states.push(state)
  });

  const result = await watcher.start("PERSON@example.com");

  assert.equal(queryCount, 2);
  assert.equal(recorded.length, 2);
  assert.equal(result.phase, "received");
  assert.equal(result.running, false);
  assert.equal(result.code, "654321");
  assert.equal(result.receivedAt, "2026-08-20T12:00:00.010Z");
  assert.equal(result.subject, "OpenAI code");
  assert.equal(states.some((state) => state.phase === "searching"), true);
  assert.equal(states.at(-1).phase, "received");
});

test("registration email watcher can perform exactly one query for GPT browser entry", async () => {
  const now = Date.parse("2026-08-20T12:00:00.000Z");
  let queryCount = 0;
  const watcher = new RegistrationEmailCodeWatcher({
    pool: {
      listMetadata: () => [{ id: "mailbox-1", providerId: "mock", address: "person@example.com", enabled: true }],
      getAccount: async () => ({ id: "mailbox-1", providerId: "mock", address: "person@example.com", credentials: { token: "opaque" } }),
      recordQueryResult: async () => undefined
    },
    providers: {
      get: () => ({
        apiVersion: 1,
        id: "mock",
        capabilities: { history: "latest", maxMessages: 1 },
        parseImport: () => ({ entries: [], failed: [] }),
        async query() {
          queryCount += 1;
          return {
            ok: true,
            messages: [{ receivedAt: new Date(now).toISOString(), codes: ["246810"], subject: "OpenAI code" }],
            codes: ["246810"]
          };
        }
      })
    },
    now: () => now,
    sleep: async () => { throw new Error("one-shot query must not sleep"); }
  });

  const result = await watcher.queryOnce("PERSON@example.com");

  assert.equal(queryCount, 1);
  assert.equal(result.phase, "received");
  assert.equal(result.code, "246810");
  assert.equal(result.running, false);
  assert.equal(watcher.isRunning(), false);
});

test("registration email watcher reports an unimported address without polling", async () => {
  let queryCount = 0;
  const watcher = new RegistrationEmailCodeWatcher({
    pool: {
      listMetadata: () => [],
      getAccount: async () => { queryCount += 1; return undefined; }
    },
    providers: { get: () => undefined }
  });

  const result = await watcher.start("missing@example.com");

  assert.equal(queryCount, 0);
  assert.equal(result.phase, "error");
  assert.match(result.message, /导入/u);
  assert.equal(result.running, false);
});

test("stopping registration email watcher cancels a pending poll", async () => {
  let releaseSleep;
  const sleepPromise = new Promise((resolve) => { releaseSleep = resolve; });
  const watcher = new RegistrationEmailCodeWatcher({
    pool: {
      listMetadata: () => [{ id: "mailbox-1", providerId: "mock", address: "person@example.com", enabled: true }],
      getAccount: async () => ({ id: "mailbox-1", providerId: "mock", address: "person@example.com", credentials: { token: "opaque" } }),
      recordQueryResult: async () => undefined
    },
    providers: {
      get: () => ({
        apiVersion: 1,
        id: "mock",
        capabilities: { history: "latest", maxMessages: 1 },
        parseImport: () => ({ entries: [], failed: [] }),
        async query() { return { ok: true, messages: [], codes: [] }; }
      })
    },
    sleep: async (_milliseconds, signal) => {
      signal.addEventListener("abort", () => releaseSleep(), { once: true });
      await sleepPromise;
      if (signal.aborted) {
        const error = new Error("cancelled");
        error.name = "AbortError";
        throw error;
      }
    },
    pollMs: 10,
    windowMs: 100
  });

  const pending = watcher.start("person@example.com");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(watcher.stop(), true);
  const result = await pending;

  assert.equal(result.phase, "cancelled");
  assert.equal(result.running, false);
  assert.equal(watcher.isRunning(), false);
});

test("refreshing registration email code restarts one watcher without creating a second poller", async () => {
  let releaseSleep;
  const sleepPromise = new Promise((resolve) => { releaseSleep = resolve; });
  let queryCount = 0;
  const watcher = new RegistrationEmailCodeWatcher({
    pool: {
      listMetadata: () => [{ id: "mailbox-1", providerId: "mock", address: "person@example.com", enabled: true }],
      getAccount: async () => ({ id: "mailbox-1", providerId: "mock", address: "person@example.com", credentials: { token: "opaque" } }),
      recordQueryResult: async () => undefined
    },
    providers: {
      get: () => ({
        apiVersion: 1,
        id: "mock",
        capabilities: { history: "latest", maxMessages: 1 },
        parseImport: () => ({ entries: [], failed: [] }),
        async query() {
          queryCount += 1;
          return queryCount === 1
            ? { ok: true, messages: [], codes: [] }
            : { ok: true, messages: [{ receivedAt: new Date().toISOString(), codes: ["765432"], subject: "refreshed" }], codes: ["765432"] };
        }
      })
    },
    pollMs: 10,
    windowMs: 1000,
    sleep: async (_milliseconds, signal) => {
      if (signal?.aborted) throw abortError();
      await new Promise((resolve, reject) => {
        const onAbort = () => { releaseSleep(); reject(abortError()); };
        signal?.addEventListener("abort", onAbort, { once: true });
        sleepPromise.then(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        });
      });
    }
  });

  const initial = watcher.start("person@example.com");
  await new Promise((resolve) => setImmediate(resolve));
  const refreshed = watcher.refresh("person@example.com");
  releaseSleep();
  const result = await refreshed;
  await initial;

  assert.equal(result.phase, "received");
  assert.equal(result.code, "765432");
  assert.equal(watcher.isRunning(), false);
  assert.equal(queryCount, 2);
});

function abortError() {
  const error = new Error("cancelled");
  error.name = "AbortError";
  return error;
}

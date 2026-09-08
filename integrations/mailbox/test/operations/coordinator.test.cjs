"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { MailboxOperationCoordinator } = require("../../src/operations/coordinator.cjs");

test("query runs selected mailboxes independently and records one failure without blocking another", async () => {
  const calls = [];
  const pool = fakePool([
    { id: "one", providerId: "8t92", email: "one@example.com" },
    { id: "two", providerId: "8t92", email: "two@example.com" }
  ]);
  const coordinator = new MailboxOperationCoordinator({
    pool,
    provider: {
      apiVersion: 1,
      id: "8t92",
      async query(account) {
        calls.push(account.id);
        if (account.id === "one") {
          throw new Error("network failure");
        }
        return { ok: true, providerId: "8t92", messages: [], codes: [] };
      },
      async renew() {
        throw new Error("unused");
      }
    }
  });

  const result = await coordinator.queryOnce(["one", "two"]);
  assert.deepEqual(calls.sort(), ["one", "two"]);
  assert.equal(result.results.length, 2);
  assert.equal(result.results.find((entry) => entry.mailboxId === "one").ok, false);
  assert.equal(result.results.find((entry) => entry.mailboxId === "two").ok, true);
  assert.deepEqual(pool.queryUpdates.sort(), ["one", "two"]);
});

test("reports completed progress for a batch query", async () => {
  const progress = [];
  const pool = fakePool([
    { id: "one", providerId: "8t92", email: "one@example.com" },
    { id: "two", providerId: "8t92", email: "two@example.com" }
  ]);
  const coordinator = new MailboxOperationCoordinator({
    pool,
    maxConcurrent: 1,
    onOperationChange(operations) {
      if (operations[0]?.progress) {
        progress.push({ kind: operations[0].kind, ...operations[0].progress });
      }
    },
    provider: {
      apiVersion: 1,
      id: "8t92",
      async query() {
        return { ok: true, providerId: "8t92", messages: [], codes: [] };
      },
      async renew() {
        throw new Error("unused");
      }
    }
  });

  await coordinator.queryOnce(["one", "two"]);

  assert.deepEqual(progress, [
    { kind: "query", completed: 0, total: 2 },
    { kind: "query", completed: 1, total: 2 }
  ]);
  assert.deepEqual(coordinator.getActiveOperations(), []);
});

test("uses the same progress contract for renewal and listening batches", async () => {
  const snapshots = [];
  const accounts = [
    { id: "one", providerId: "8t92", email: "one@example.com" },
    { id: "two", providerId: "8t92", email: "two@example.com" }
  ];
  const pool = fakePool(accounts);
  const coordinator = new MailboxOperationCoordinator({
    pool,
    maxConcurrent: 1,
    onOperationChange(operations) {
      const current = operations[0];
      if (current?.progress) snapshots.push({ kind: current.kind, ...current.progress });
    },
    provider: {
      apiVersion: 1,
      id: "8t92",
      async query() {
        return { ok: true, providerId: "8t92", messages: [], codes: [] };
      },
      async renew() {
        return { ok: true, providerId: "8t92", operation: "renewal", status: "unchanged" };
      }
    }
  });

  await coordinator.renew(accounts.map((account) => account.id));
  await coordinator.waitForCodes(accounts.map((account) => account.id), {
    timeoutMs: 1,
    pollMs: 1
  });

  assert.ok(snapshots.some((snapshot) => snapshot.kind === "renewal" && snapshot.total === 2));
  assert.ok(snapshots.some((snapshot) => snapshot.kind === "wait" && snapshot.total === 2));
});

test("limits concurrent provider operations for a large batch", async () => {
  const accounts = Array.from({ length: 7 }, (_, index) => ({
    id: `mailbox-${index + 1}`,
    providerId: "8t92",
    email: `mailbox-${index + 1}@example.com`
  }));
  const pool = fakePool(accounts);
  let active = 0;
  let maximumActive = 0;
  const coordinator = new MailboxOperationCoordinator({
    pool,
    maxConcurrent: 2,
    provider: {
      apiVersion: 1,
      id: "8t92",
      async query() {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        return { ok: true, providerId: "8t92", messages: [], codes: [] };
      },
      async renew() {
        throw new Error("unused");
      }
    }
  });

  const result = await coordinator.queryOnce(accounts.map((account) => account.id));

  assert.equal(result.results.length, accounts.length);
  assert.equal(maximumActive, 2);
  assert.deepEqual(pool.queryUpdates.sort(), accounts.map((account) => account.id).sort());
});

test("defaults large batch concurrency to ten", async () => {
  const accounts = Array.from({ length: 12 }, (_, index) => ({
    id: `mailbox-${index + 1}`,
    providerId: "8t92",
    email: `mailbox-${index + 1}@example.com`
  }));
  const pool = fakePool(accounts);
  let active = 0;
  let maximumActive = 0;
  const coordinator = new MailboxOperationCoordinator({
    pool,
    provider: {
      apiVersion: 1,
      id: "8t92",
      async query() {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        return { ok: true, providerId: "8t92", messages: [], codes: [] };
      },
      async renew() {
        throw new Error("unused");
      }
    }
  });

  await coordinator.queryOnce(accounts.map((account) => account.id));

  assert.equal(maximumActive, 10);
});

test("stopping a queued batch mailbox prevents it from starting", async () => {
  const pool = fakePool([
    { id: "one", providerId: "8t92", email: "one@example.com" },
    { id: "two", providerId: "8t92", email: "two@example.com" }
  ]);
  const started = [];
  let release;
  const coordinator = new MailboxOperationCoordinator({
    pool,
    maxConcurrent: 1,
    provider: {
      apiVersion: 1,
      id: "8t92",
      async query(account) {
        started.push(account.id);
        if (account.id === "one") {
          await new Promise((resolve) => {
            release = resolve;
          });
        }
        return { ok: true, providerId: "8t92", messages: [], codes: [] };
      },
      async renew() {
        throw new Error("unused");
      }
    }
  });

  const pending = coordinator.queryOnce(["one", "two"]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["one"]);
  assert.equal(coordinator.stop("two"), true);
  release();

  const result = await pending;
  assert.deepEqual(started, ["one"]);
  assert.equal(result.results.find((entry) => entry.mailboxId === "two").error.code, "request_aborted");
});

test("waitForCodes ignores the initial mailbox snapshot and finds a later code", async () => {
  let call = 0;
  let now = 1_000;
  const pool = fakePool([{ id: "one", providerId: "8t92", email: "one@example.com" }]);
  const coordinator = new MailboxOperationCoordinator({
    pool,
    now: () => now,
    sleep: async () => {
      now += 10;
    },
    provider: {
      apiVersion: 1,
      id: "8t92",
      async query() {
        call += 1;
        return {
          ok: true,
          providerId: "8t92",
          messages: call === 1
            ? [{ fingerprint: "old", codes: ["111111"] }]
            : [{ fingerprint: "new", receivedAt: new Date(now).toISOString(), codes: ["222222"] }],
          codes: call === 1 ? ["111111"] : ["222222"]
        };
      },
      async renew() {
        throw new Error("unused");
      }
    }
  });

  const result = await coordinator.waitForCodes(["one"], { timeoutMs: 100, pollMs: 10 });
  assert.equal(call, 2);
  assert.equal(result.results[0].status, "code_found");
  assert.deepEqual(result.results[0].codes, ["222222"]);
});

test("stop aborts a manual wait and leaves no active operation", async () => {
  const pool = fakePool([{ id: "one", providerId: "8t92", email: "one@example.com" }]);
  const coordinator = new MailboxOperationCoordinator({
    pool,
    provider: {
      apiVersion: 1,
      id: "8t92",
      async query(_account, { signal }) {
        await new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })));
        });
      },
      async renew() {
        throw new Error("unused");
      }
    }
  });

  const pending = coordinator.waitForCodes(["one"], { timeoutMs: 100_000, pollMs: 100_000 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(coordinator.stop(), true);
  const result = await pending;
  assert.equal(result.stopped, true);
  assert.equal(coordinator.isActive(), false);
});

test("stop releases the operation slot even when a provider ignores abort", async () => {
  const pool = fakePool([{ id: "one", providerId: "8t92", email: "one@example.com" }]);
  let release;
  const provider = {
    apiVersion: 1,
    id: "8t92",
    async query() {
      await new Promise((resolve) => { release = resolve; });
      return { ok: true, providerId: "8t92", messages: [], codes: [] };
    },
    async renew() {
      throw new Error("unused");
    }
  };
  const coordinator = new MailboxOperationCoordinator({ pool, provider });
  const pending = coordinator.queryOnce(["one"]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(coordinator.stop("one"), true);
  assert.equal(coordinator.isActive("one"), false);
  release();
  const result = await pending;
  assert.equal(result.stopped, true);
  assert.deepEqual(pool.queryUpdates, []);
});

function fakePool(accounts) {
  return {
    queryUpdates: [],
    renewalUpdates: [],
    async listAccounts() {
      return accounts;
    },
    async recordQueryResult(id) {
      this.queryUpdates.push(id);
    },
    async recordRenewalResult(id) {
      this.renewalUpdates.push(id);
    }
  };
}

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

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { RegistrationKeyPool } = require("../../src/operations/registration-key-pool.cjs");

test("registration key pool keeps secrets private and removes a key only after SMS receipt", async () => {
  const store = createSecretStore();
  const pool = new RegistrationKeyPool({ secretStore: store });

  const added = await pool.add("GPT-AAAA\nGPT-BBBB");
  assert.equal(added.added, 2);
  assert.equal(added.keys.some((key) => key.masked === "GPT…AAA"), true);
  assert.doesNotMatch(JSON.stringify(added), /GPT-AAAA|GPT-BBBB/u);
  assert.match(store.values.get("codexAccounts.mailbox.registrationKeys.v1"), /GPT-AAAA/u);

  const keyId = added.keys[0].id;
  const claimed = await pool.claim(keyId, "registration:session-1");
  assert.equal(claimed.code, "GPT-AAAA");
  assert.equal((await pool.snapshot()).inUse, 1);

  assert.equal(await pool.release(keyId, "registration:session-1"), true);
  assert.equal((await pool.snapshot()).available, 2);
  await pool.claim(keyId, "registration:session-1");
  assert.equal(await pool.consume(keyId, "registration:session-1"), true);
  const remaining = await pool.snapshot();
  assert.equal(remaining.count, 1);
  assert.equal(remaining.keys[0].masked, "GPT…BBB");
});

test("registration key pool does not release or consume another session's claim", async () => {
  const pool = new RegistrationKeyPool({ secretStore: createSecretStore() });
  const { keys } = await pool.add("ONLY-KEY");
  await pool.claim(keys[0].id, "registration:owner-a");

  await assert.rejects(() => pool.claim(keys[0].id, "registration:owner-b"), /正在使用/u);
  assert.equal(await pool.release(keys[0].id, "registration:owner-b"), false);
  await assert.rejects(() => pool.consume(keys[0].id, "registration:owner-b"), /当前取号任务/u);
  assert.equal((await pool.snapshot()).inUse, 1);
});

test("stale key leases become available again", async () => {
  let now = 1_000_000;
  const store = createSecretStore();
  const pool = new RegistrationKeyPool({ secretStore: store, now: () => now, leaseTtlMs: 100 });
  const { keys } = await pool.add("STALE-KEY");
  await pool.claim(keys[0].id, "registration:owner");
  now += 101;

  const snapshot = await pool.snapshot();
  assert.equal(snapshot.available, 1);
  assert.equal(snapshot.inUse, 0);
});

function createSecretStore() {
  const values = new Map();
  return {
    values,
    async get(key) { return values.get(key); },
    async store(key, value) { values.set(key, value); },
  };
}

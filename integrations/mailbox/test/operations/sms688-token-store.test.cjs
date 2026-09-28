"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { Sms688TokenStore } = require("../../src/operations/sms688-token-store.cjs");

test("SMS688 API Key storage is independent and exposes only a mask", async () => {
  const store = new Sms688TokenStore({ secretStore: memoryStore() });

  const saved = await store.set("sms688-account-api-key");
  assert.equal(saved.configured, true);
  assert.equal(saved.masked, "sms6…-key");
  assert.deepEqual(await store.snapshot(), { configured: true, masked: "sms6…-key" });
  assert.equal(await store.get(), "sms688-account-api-key");

  await store.clear();
  assert.deepEqual(await store.snapshot(), { configured: false, masked: "" });
});

function memoryStore() {
  const values = new Map();
  return {
    async get(key) { return values.get(key); },
    async store(key, value) { values.set(key, value); }
  };
}

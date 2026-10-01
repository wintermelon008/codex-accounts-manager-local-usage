"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  FutureTokenStore,
  maskFutureToken
} = require("../../src/operations/future-token-store.cjs");

test("Future token store persists only the redeemed session token and exposes a mask", async () => {
  const store = new FutureTokenStore({ secretStore: memoryStore() });
  await store.set("future-session-token");

  assert.equal(await store.get(), "future-session-token");
  assert.deepEqual(await store.snapshot(), { configured: true, masked: "futu…oken" });
  assert.equal(maskFutureToken(""), "");

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

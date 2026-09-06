"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { FiveSimTokenStore } = require("../../src/operations/fivesim-token-store.cjs");

test("5SIM token storage is separate from the registration Key pool and exposes only a mask", async () => {
  const store = new FiveSimTokenStore({ secretStore: memoryStore() });

  const saved = await store.set("five-sim-secret-token");
  assert.equal(saved.configured, true);
  assert.equal(saved.masked, "five…oken");
  assert.deepEqual(await store.snapshot(), { configured: true, masked: "five…oken" });
  assert.equal(await store.get(), "five-sim-secret-token");

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

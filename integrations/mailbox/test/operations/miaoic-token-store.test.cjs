"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  MiaoicTokenStore,
  maskMiaoicToken
} = require("../../src/operations/miaoic-token-store.cjs");

test("Miaoic Token storage is independent and exposes only a mask", async () => {
  const store = new MiaoicTokenStore({ secretStore: memoryStore() });

  const saved = await store.set("miaoic-secret-token");
  assert.equal(saved.masked, "miao…oken");
  assert.deepEqual(await store.snapshot(), { configured: true, masked: "miao…oken" });
  assert.equal(await store.get(), "miaoic-secret-token");
  assert.equal(maskMiaoicToken(""), "");
  await assert.rejects(() => store.set("bad;cookie"), /无效字符/u);
});

function memoryStore() {
  const values = new Map();
  return {
    async get(key) { return values.get(key); },
    async store(key, value) { values.set(key, value); }
  };
}

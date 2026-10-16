"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  MiaoicTokenStore,
  maskMiaoicToken
} = require("../../src/operations/miaoic-token-store.cjs");

test("Miaoic internal account storage is independent and exposes no credential", async () => {
  const store = new MiaoicTokenStore({ secretStore: memoryStore() });

  const saved = await store.set("0123456789abcdef0123456789abcdef");
  assert.equal(saved.masked, "");
  assert.deepEqual(await store.snapshot(), { configured: true, masked: "" });
  assert.equal(await store.get(), "0123456789abcdef0123456789abcdef");
  assert.equal(maskMiaoicToken(""), "");
  await assert.rejects(() => store.set("bad;cookie"), /格式无效/u);
});

function memoryStore() {
  const values = new Map();
  return {
    async get(key) { return values.get(key); },
    async store(key, value) { values.set(key, value); }
  };
}

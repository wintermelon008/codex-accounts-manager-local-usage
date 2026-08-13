"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { Eight92Provider } = require("../../src/core/providers/eight92.cjs");
const { createMailboxProvider } = require("../../src/core/provider.cjs");
const { MailboxPool, METADATA_KEY, detailKey, secretKey } = require("../../src/mailbox/storage.cjs");

test("metadata stores complete mailbox identity but never stores provider credentials", async () => {
  const stores = memoryStores();
  const pool = new MailboxPool({ metadataStore: stores.metadata, secretStore: stores.secretStore });
  const provider = new Eight92Provider({ fetchImpl: async () => response({}) }).asProvider();
  await pool.load();
  const result = await pool.importProvider({
    provider,
    input: [
      "one@example.com----password-one----client-one----refresh-one",
      "malformed-row"
    ].join("\n"),
    displayName: "注册邮箱 1"
  });

  assert.equal(result.imported.length, 1);
  assert.equal(result.failed.length, 1);
  assert.equal(result.imported[0].address, "one@example.com");
  assert.equal(result.imported[0].displayName, "注册邮箱 1");
  assert.equal(stores.metadata.values.get(METADATA_KEY).accounts[0].address, "one@example.com");
  assert.equal("credentials" in stores.metadata.values.get(METADATA_KEY).accounts[0], false);
  assert.match(stores.secretStore.values.get(secretKey(result.imported[0].id)), /refresh-one/u);
});

test("query details are persisted separately and only selected details need to be read", async () => {
  const stores = memoryStores();
  const pool = new MailboxPool({ metadataStore: stores.metadata, secretStore: stores.secretStore });
  const provider = new Eight92Provider({ fetchImpl: async () => response({}) }).asProvider();
  await pool.load();
  const [{ id }] = (await pool.importProvider({ provider, input: "one@example.com----password-one----client-one----refresh-one" })).imported;
  await pool.recordQueryResult(id, {
    ok: true,
    providerId: provider.id,
    fetchedAt: "2026-08-13T00:00:00.000Z",
    codes: ["123456"],
    messages: [{ id: "message", subject: "Code", from: "sender@example.com", codes: ["123456"], body: "hello" }]
  }, { historyMode: "recent" });

  assert.equal(stores.metadata.values.has(detailKey(id)), true);
  assert.equal((await pool.getDetail(id)).messages[0].from, "sender@example.com");
  assert.equal(pool.listMetadata()[0].latestCode, "123456");
});

test("renewal writes a new secret only after the provider reports changed credentials", async () => {
  let clock = 100;
  const stores = memoryStores();
  const pool = new MailboxPool({ metadataStore: stores.metadata, secretStore: stores.secretStore, now: () => ++clock });
  const provider = new Eight92Provider({ fetchImpl: async () => response({}) }).asProvider();
  await pool.load();
  const [{ id }] = (await pool.importProvider({ provider, input: "one@example.com----password-one----client-one----refresh-one" })).imported;

  await pool.recordRenewalResult(id, {
    ok: true,
    status: "unchanged",
    account: { address: "one@example.com", credentials: { refreshToken: "should-not-write" } }
  });
  assert.match(stores.secretStore.values.get(secretKey(id)), /refresh-one/u);

  await pool.recordRenewalResult(id, {
    ok: true,
    status: "updated",
    account: {
      address: "one@example.com",
      credentials: { email: "one@example.com", password: "password-one", clientId: "client-one", refreshToken: "refresh-two" }
    }
  });
  assert.match(stores.secretStore.values.get(secretKey(id)), /refresh-two/u);
  assert.equal((await pool.getAccount(id)).credentials.refreshToken, "refresh-two");
});

test("editing changes the display name and can replace opaque provider credentials", async () => {
  const stores = memoryStores();
  const pool = new MailboxPool({ metadataStore: stores.metadata, secretStore: stores.secretStore });
  const provider = new Eight92Provider({ fetchImpl: async () => response({}) }).asProvider();
  await pool.load();
  const [{ id }] = (await pool.importProvider({ provider, input: "one@example.com----password-one----client-one----refresh-one" })).imported;

  const updated = await pool.updateAccount(id, {
    provider,
    displayName: "主注册邮箱",
    input: "one@example.com----password-two----client-one----refresh-two"
  });
  assert.equal(updated.displayName, "主注册邮箱");
  assert.equal((await pool.getAccount(id)).credentials.refreshToken, "refresh-two");
});

test("deleting an account removes its secret, detail and metadata entry", async () => {
  const stores = memoryStores();
  const pool = new MailboxPool({ metadataStore: stores.metadata, secretStore: stores.secretStore });
  const provider = new Eight92Provider({ fetchImpl: async () => response({}) }).asProvider();
  await pool.load();
  const [{ id }] = (await pool.importProvider({ provider, input: "one@example.com----password-one----client-one----refresh-one" })).imported;
  await pool.recordQueryResult(id, { ok: true, messages: [{ id: "message", subject: "Code", body: "hello" }] });

  await pool.deleteAccount(id);
  assert.equal(pool.listMetadata().length, 0);
  assert.equal(stores.secretStore.values.has(secretKey(id)), false);
  assert.equal(stores.metadata.values.has(detailKey(id)), false);
});

test("editing can switch the provider format while keeping the mailbox address", async () => {
  const stores = memoryStores();
  const pool = new MailboxPool({ metadataStore: stores.metadata, secretStore: stores.secretStore });
  const sourceProvider = new Eight92Provider({ fetchImpl: async () => response({}) }).asProvider();
  const replacementProvider = createMailboxProvider({
    id: "mock-format",
    displayName: "Mock format",
    parseImport(input) {
      const [address, token] = String(input).split("|");
      return { entries: [{ address, credentials: { token } }], failed: [] };
    },
    async query() { return { ok: true, messages: [], codes: [] }; }
  });
  await pool.load();
  const [{ id }] = (await pool.importProvider({
    provider: sourceProvider,
    input: "one@example.com----password-one----client-one----refresh-one"
  })).imported;

  const updated = await pool.updateAccount(id, {
    provider: replacementProvider,
    providerId: replacementProvider.id,
    input: "one@example.com|replacement-token",
    displayName: "替换来源"
  });
  assert.equal(updated.providerId, "mock-format");
  assert.equal(updated.address, "one@example.com");
  assert.equal((await pool.getAccount(id)).credentials.token, "replacement-token");
});

function memoryStores() {
  const metadata = new Map();
  const secrets = new Map();
  return {
    metadata: {
      values: metadata,
      async get(key) { return metadata.get(key); },
      async update(key, value) {
        if (value === undefined) metadata.delete(key);
        else metadata.set(key, structuredClone(value));
      }
    },
    secretStore: {
      values: secrets,
      async get(key) { return secrets.get(key); },
      async store(key, value) { secrets.set(key, value); },
      async delete(key) { secrets.delete(key); }
    }
  };
}

function response(data) {
  return { ok: true, status: 200, json: async () => data };
}

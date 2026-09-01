"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { BoyaProvider } = require("../../src/core/providers/boya.cjs");
const { CdnsProvider } = require("../../src/core/providers/cdns.cjs");
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

test("boya private tokens stay in the Mailbox secret store and out of public metadata", async () => {
  const stores = memoryStores();
  const pool = new MailboxPool({ metadataStore: stores.metadata, secretStore: stores.secretStore });
  const provider = new BoyaProvider({ fetchImpl: async () => response({}) }).asProvider();
  await pool.load();

  const result = await pool.importProvider({
    provider,
    input: "boya-user@example.com----boya-private-token"
  });
  const mailboxId = result.imported[0].id;

  assert.doesNotMatch(JSON.stringify(pool.listMetadata()), /boya-private-token/u);
  assert.doesNotMatch(JSON.stringify(stores.metadata.values.get(METADATA_KEY)), /boya-private-token/u);
  assert.match(stores.secretStore.values.get(secretKey(mailboxId)), /boya-private-token/u);
  assert.equal((await pool.getAccount(mailboxId)).credentials.privateToken, "boya-private-token");
});

test("cdns credentials stay in the Mailbox secret store and out of public metadata", async () => {
  const stores = memoryStores();
  const pool = new MailboxPool({ metadataStore: stores.metadata, secretStore: stores.secretStore });
  const provider = new CdnsProvider({ fetchImpl: async () => response({}) }).asProvider();
  await pool.load();

  const result = await pool.importProvider({
    provider,
    input: "cdns-user@example.com----cdns-password----cdns-receive-token----cdns-public-ref"
  });
  const mailboxId = result.imported[0].id;

  assert.doesNotMatch(JSON.stringify(pool.listMetadata()), /cdns-password|cdns-receive-token|cdns-public-ref/u);
  assert.doesNotMatch(JSON.stringify(stores.metadata.values.get(METADATA_KEY)), /cdns-password|cdns-receive-token|cdns-public-ref/u);
  assert.match(stores.secretStore.values.get(secretKey(mailboxId)), /cdns-receive-token/u);
  assert.equal((await pool.getAccount(mailboxId)).credentials.publicRef, "cdns-public-ref");
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

test("querying an OpenAI deactivation notice marks the mailbox and keeps the marker after reload", async () => {
  const stores = memoryStores();
  const pool = new MailboxPool({ metadataStore: stores.metadata, secretStore: stores.secretStore });
  const provider = new Eight92Provider({ fetchImpl: async () => response({}) }).asProvider();
  await pool.load();
  const [{ id }] = (await pool.importProvider({
    provider,
    input: "deactivated@example.com----password----client----refresh"
  })).imported;

  const ordinary = await pool.recordQueryResult(id, {
    ok: true,
    messages: [{ id: "ordinary", subject: "OpenAI verification code", from: ["no-reply", "openai.com"].join("@") }]
  });
  assert.equal(ordinary.openaiAccountDeactivated, false);

  const marked = await pool.recordQueryResult(id, {
    ok: true,
    messages: [{
      id: "deactivated",
      subject: "Your account has been deactivated",
      from: ["no-reply", "openai.com"].join("@"),
      body: "Your account has been deactivated."
    }]
  });
  assert.equal(marked.openaiAccountDeactivated, true);

  const restored = new MailboxPool({ metadataStore: stores.metadata, secretStore: stores.secretStore });
  await restored.load();
  assert.equal(restored.listMetadata()[0].openaiAccountDeactivated, true);
});

test("a clean successful query clears a stale deactivation marker", async () => {
  const stores = memoryStores();
  const pool = new MailboxPool({ metadataStore: stores.metadata, secretStore: stores.secretStore });
  const provider = new Eight92Provider({ fetchImpl: async () => response({}) }).asProvider();
  await pool.load();
  const [{ id }] = (await pool.importProvider({
    provider,
    input: "stale@example.com----password----client----refresh"
  })).imported;

  await pool.recordQueryResult(id, {
    ok: true,
    messages: [{
      id: "stale-deactivated",
      subject: "Your account has been deactivated",
      from: ["no-reply", "openai.com"].join("@"),
      body: "Your account has been deactivated."
    }]
  });
  assert.equal(pool.listMetadata()[0].openaiAccountDeactivated, true);

  const cleared = await pool.recordQueryResult(id, {
    ok: true,
    messages: [{ id: "ordinary", subject: "OpenAI verification code", from: ["no-reply", "openai.com"].join("@") }]
  });
  assert.equal(cleared.openaiAccountDeactivated, false);
  assert.equal(pool.listMetadata()[0].openaiAccountDeactivated, false);
});

test("loading the pool backfills deactivation markers from existing message details", async () => {
  const stores = memoryStores();
  const pool = new MailboxPool({ metadataStore: stores.metadata, secretStore: stores.secretStore });
  const provider = new Eight92Provider({ fetchImpl: async () => response({}) }).asProvider();
  await pool.load();
  const [{ id }] = (await pool.importProvider({
    provider,
    input: "historical@example.com----password----client----refresh"
  })).imported;

  await stores.metadata.update(detailKey(id), {
    mailboxId: id,
    messages: [{
      id: "historical-deactivated",
      subject: "OpenAI account deactivated",
      from: ["no-reply", "openai.com"].join("@"),
      body: "Your account has been deactivated."
    }]
  });

  const restored = new MailboxPool({ metadataStore: stores.metadata, secretStore: stores.secretStore });
  await restored.load();
  assert.equal(restored.listMetadata()[0].openaiAccountDeactivated, true);
});

test("loading the pool clears a stale marker when stored details have no deactivation notice", async () => {
  const stores = memoryStores();
  const pool = new MailboxPool({ metadataStore: stores.metadata, secretStore: stores.secretStore });
  const provider = new Eight92Provider({ fetchImpl: async () => response({}) }).asProvider();
  await pool.load();
  const [{ id }] = (await pool.importProvider({
    provider,
    input: "stale-detail@example.com----password----client----refresh"
  })).imported;

  const metadata = stores.metadata.values.get(METADATA_KEY);
  metadata.accounts[0].openaiAccountDeactivated = true;
  await stores.metadata.update(METADATA_KEY, metadata);
  await stores.metadata.update(detailKey(id), {
    mailboxId: id,
    messages: [{ id: "ordinary", subject: "OpenAI verification code", from: ["no-reply", "openai.com"].join("@") }]
  });

  const restored = new MailboxPool({ metadataStore: stores.metadata, secretStore: stores.secretStore });
  await restored.load();
  assert.equal(restored.listMetadata()[0].openaiAccountDeactivated, false);
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
  assert.equal(pool.listMetadata()[0].lastRenewalAt, undefined);

  const renewed = await pool.recordRenewalResult(id, {
    ok: true,
    status: "updated",
    account: {
      address: "one@example.com",
      credentials: { email: "one@example.com", password: "password-one", clientId: "client-one", refreshToken: "refresh-two" }
    }
  });
  assert.match(stores.secretStore.values.get(secretKey(id)), /refresh-two/u);
  assert.equal((await pool.getAccount(id)).credentials.refreshToken, "refresh-two");
  assert.equal(renewed.lastRenewalAt, 103);

  await pool.recordRenewalResult(id, {
    ok: false,
    status: "error",
    error: { stage: "refresh", code: "temporary_failure", message: "temporary failure" }
  });
  assert.equal(pool.listMetadata()[0].lastRenewalAt, 103);
});

test("overlapping successful renewals preserve every mailbox timestamp", async () => {
  let clock = 100;
  const stores = memoryStores();
  let metadataReads = 0;
  let secretReads = 0;
  const metadataGet = stores.metadata.get;
  stores.metadata.get = async (key) => {
    const value = await metadataGet(key);
    if (key === METADATA_KEY) {
      const delay = metadataReads++ === 0 ? 0 : 10;
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    }
    return value;
  };
  const secretGet = stores.secretStore.get;
  stores.secretStore.get = async (key) => {
    const value = await secretGet(key);
    const delay = secretReads++ === 0 ? 20 : 0;
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    return value;
  };
  const pool = new MailboxPool({ metadataStore: stores.metadata, secretStore: stores.secretStore, now: () => ++clock });
  const provider = new Eight92Provider({ fetchImpl: async () => response({}) }).asProvider();
  await pool.load();
  const imported = (await pool.importProvider({
    provider,
    input: [
      "one@example.com----password-one----client-one----refresh-one",
      "two@example.com----password-two----client-two----refresh-two"
    ].join("\n")
  })).imported;
  metadataReads = 0;
  secretReads = 0;

  await Promise.all(imported.map((mailbox, index) => pool.recordRenewalResult(mailbox.id, {
    ok: true,
    status: "updated",
    account: {
      address: mailbox.address,
      credentials: {
        email: mailbox.address,
        password: "password-" + (index === 0 ? "one" : "two"),
        clientId: "client-" + (index === 0 ? "one" : "two"),
        refreshToken: "refresh-renewed-" + (index + 1)
      }
    }
  })));

  const persisted = stores.metadata.values.get(METADATA_KEY);
  assert.equal(persisted.accounts.filter((account) => account.lastRenewalAt != null).length, 2);
  assert.deepEqual(
    new Map(persisted.accounts.map((account) => [account.address, account.lastRenewalAt])),
    new Map([["one@example.com", 103], ["two@example.com", 104]])
  );
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

test("GPT registration status persists through reimport, editing, and a new pool instance", async () => {
  let clock = 100;
  const stores = memoryStores();
  const pool = new MailboxPool({ metadataStore: stores.metadata, secretStore: stores.secretStore, now: () => ++clock });
  const provider = new Eight92Provider({ fetchImpl: async () => response({}) }).asProvider();
  await pool.load();
  const [{ id }] = (await pool.importProvider({
    provider,
    input: "gpt-status@example.com----password-one----client-one----refresh-one"
  })).imported;

  const marked = await pool.markGptRegistered(id);
  assert.equal(marked.gptRegistered, true);
  assert.equal(marked.gptRegisteredAt, 102);

  const reimported = (await pool.importProvider({
    provider,
    input: "gpt-status@example.com----password-two----client-one----refresh-two",
    displayName: "已注册 GPT"
  })).imported[0];
  assert.equal(reimported.gptRegistered, true);
  assert.equal(reimported.gptRegisteredAt, 102);

  const edited = await pool.updateAccount(id, {
    provider,
    input: "gpt-status@example.com----password-three----client-one----refresh-three",
    displayName: "已注册 GPT（已编辑）"
  });
  assert.equal(edited.gptRegistered, true);
  assert.equal(edited.gptRegisteredAt, 102);

  const restored = new MailboxPool({ metadataStore: stores.metadata, secretStore: stores.secretStore });
  await restored.load();
  assert.equal(restored.listMetadata()[0].gptRegistered, true);
  assert.equal(restored.listMetadata()[0].gptRegisteredAt, 102);
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

  await pool.recordQueryResult(id, {
    ok: true,
    messages: [{
      id: "deactivated",
      subject: "Your account has been deactivated",
      from: ["no-reply", "openai.com"].join("@"),
      body: "Your account has been deactivated."
    }]
  });
  assert.equal(pool.listMetadata()[0].openaiAccountDeactivated, true);

  const updated = await pool.updateAccount(id, {
    provider: replacementProvider,
    providerId: replacementProvider.id,
    input: "one@example.com|replacement-token",
    displayName: "替换来源"
  });
  assert.equal(updated.providerId, "mock-format");
  assert.equal(updated.address, "one@example.com");
  assert.equal(updated.openaiAccountDeactivated, false);
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

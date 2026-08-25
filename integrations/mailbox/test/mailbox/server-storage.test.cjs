"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  REGISTRATION_SESSION_FILE,
  createServerMailboxStores,
  createServerRegistrationSessionStore
} = require("../../src/mailbox/server-storage.cjs");
const { METADATA_KEY, secretKey } = require("../../src/mailbox/storage.cjs");

test("mailbox state and credentials are shared through the server extension directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-mailbox-server-store-"));
  try {
    const first = createServerMailboxStores({
      storageUri: { fsPath: root },
      legacyMetadataStore: createLegacyStore(),
      legacySecretStore: createLegacyStore(),
      sourceId: "device-a"
    });
    await first.migrateLegacy();
    await first.metadataStore.update(METADATA_KEY, {
      version: 2,
      accounts: [{ id: "mailbox:one", providerId: "mock", address: "one@example.com" }]
    });
    await first.secretStore.store(secretKey("mailbox:one"), '{"credentials":{"token":"server-only-token"}}');

    const second = createServerMailboxStores({
      storageUri: { fsPath: root },
      legacyMetadataStore: createLegacyStore(),
      legacySecretStore: createLegacyStore(),
      sourceId: "device-b"
    });
    await second.migrateLegacy();

    assert.equal((await second.metadataStore.get(METADATA_KEY)).accounts[0].address, "one@example.com");
    assert.match(await second.secretStore.get(secretKey("mailbox:one")), /server-only-token/u);

    const metadataFile = await fs.stat(path.join(root, "mailbox-shared-state.v1.json"));
    const secretFile = await fs.stat(path.join(root, "mailbox-shared-secrets.v1.json"));
    assert.equal(metadataFile.mode & 0o777, 0o600);
    assert.equal(secretFile.mode & 0o777, 0o600);
    assert.doesNotMatch(await fs.readFile(path.join(root, "mailbox-shared-state.v1.json"), "utf8"), /server-only-token/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("legacy mailbox stores from different clients are merged once into the server store", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-mailbox-migration-"));
  try {
    const legacyA = createLegacyStorePair();
    await legacyA.metadata.update(METADATA_KEY, {
      version: 2,
      accounts: [{ id: "mailbox:one", providerId: "mock", address: "one@example.com" }]
    });
    await legacyA.secrets.store(secretKey("mailbox:one"), '{"credentials":{"token":"token-one"}}');
    const first = createServerMailboxStores({
      storageUri: { fsPath: root },
      legacyMetadataStore: legacyA.metadata,
      legacySecretStore: legacyA.secrets,
      sourceId: "device-a"
    });
    await first.migrateLegacy();

    const legacyB = createLegacyStorePair();
    await legacyB.metadata.update(METADATA_KEY, {
      version: 2,
      accounts: [{ id: "mailbox:two", providerId: "mock", address: "two@example.com" }]
    });
    await legacyB.secrets.store(secretKey("mailbox:two"), '{"credentials":{"token":"token-two"}}');
    const second = createServerMailboxStores({
      storageUri: { fsPath: root },
      legacyMetadataStore: legacyB.metadata,
      legacySecretStore: legacyB.secrets,
      sourceId: "device-b"
    });
    await second.migrateLegacy();

    const metadata = await second.metadataStore.get(METADATA_KEY);
    assert.deepEqual(metadata.accounts.map((account) => account.address).sort(), ["one@example.com", "two@example.com"]);
    assert.match(await second.secretStore.get(secretKey("mailbox:one")), /token-one/u);
    assert.match(await second.secretStore.get(secretKey("mailbox:two")), /token-two/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("registration assistant records are shared without persisting passwords", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-registration-server-store-"));
  try {
    const first = createServerRegistrationSessionStore({ storageUri: { fsPath: root } });
    await first.save([{
      id: "session-1",
      email: "one@example.com",
      mode: "oauth",
      state: "completed",
      result: { email: "one@example.com", accountId: "account-1", password: "must-not-persist" }
    }]);

    const second = createServerRegistrationSessionStore({ storageUri: { fsPath: root } });
    const records = await second.load();
    assert.equal(records[0].email, "one@example.com");
    assert.equal(records[0].result.accountId, "account-1");
    assert.equal("password" in records[0].result, false);
    assert.equal((await fs.stat(path.join(root, REGISTRATION_SESSION_FILE))).mode & 0o777, 0o600);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

function createLegacyStorePair() {
  return { metadata: createLegacyStore(), secrets: createLegacyStore() };
}

function createLegacyStore() {
  const values = new Map();
  return {
    async get(key) { return values.get(key); },
    async update(key, value) {
      if (value === undefined) values.delete(key);
      else values.set(key, structuredClone(value));
    },
    async store(key, value) { values.set(key, value); },
    async delete(key) { values.delete(key); }
  };
}

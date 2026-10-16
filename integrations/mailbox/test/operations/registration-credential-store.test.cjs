"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  DEFAULT_FILE_NAME: fiveSimFile,
  DEFAULT_STORE_KEY: fiveSimKey,
  FiveSimTokenStore,
  createLocalFiveSimTokenStore
} = require("../../src/operations/fivesim-token-store.cjs");
const {
  DEFAULT_FILE_NAME: sms688File,
  DEFAULT_STORE_KEY: sms688Key,
  Sms688TokenStore,
  createLocalSms688TokenStore
} = require("../../src/operations/sms688-token-store.cjs");
const {
  DEFAULT_FILE_NAME: futureFile,
  DEFAULT_STORE_KEY: futureKey,
  FutureTokenStore,
  createLocalFutureTokenStore
} = require("../../src/operations/future-token-store.cjs");
const {
  DEFAULT_FILE_NAME: miaoicFile,
  DEFAULT_STORE_KEY: miaoicKey,
  MiaoicTokenStore,
  createLocalMiaoicTokenStore
} = require("../../src/operations/miaoic-token-store.cjs");

const temporaryRoots = new Set();

test.after(() => {
  for (const root of temporaryRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("provider adapters keep independent keys and the existing payload format", async () => {
  const values = new Map();
  const secretStore = memoryStore(values);
  const cases = [
    { Store: FiveSimTokenStore, key: fiveSimKey, token: "five-sim-test-token" },
    { Store: Sms688TokenStore, key: sms688Key, token: "sms688-test-api-key" },
    { Store: FutureTokenStore, key: futureKey, token: "future-test-session-token" },
    { Store: MiaoicTokenStore, key: miaoicKey, token: "0123456789abcdef0123456789abcdef" }
  ];

  for (const { Store, key, token } of cases) {
    const store = new Store({ secretStore });
    await store.set(token);
    assert.equal(await store.get(), token);
    assert.deepEqual(JSON.parse(values.get(key)), { version: 1, token });
  }

  assert.deepEqual([...values.keys()].sort(), [fiveSimKey, sms688Key, futureKey, miaoicKey].sort());
});

test("backup recovery promotes the unchanged credential payload", async () => {
  const primaryValues = new Map();
  const backupValues = new Map();
  const token = "backup-recovery-test-token";
  const payload = JSON.stringify({ version: 1, token });
  backupValues.set(fiveSimKey, payload);

  const store = new FiveSimTokenStore({
    secretStore: memoryStore(primaryValues),
    backupStore: memoryStore(backupValues)
  });

  assert.equal(await store.get(), token);
  assert.equal(primaryValues.get(fiveSimKey), payload);
});

test("legacy string payloads remain readable", async () => {
  const values = new Map([[futureKey, JSON.stringify("legacy-future-token")] ]);
  const store = new FutureTokenStore({ secretStore: memoryStore(values) });

  assert.equal(await store.get(), "legacy-future-token");
});

test("provider-specific validation remains in the adapters", async () => {
  await assert.rejects(
    () => new FiveSimTokenStore({ secretStore: memoryStore() }).set("x".repeat(2049)),
    /5SIM API Token 过长/u
  );
  await assert.rejects(
    () => new FutureTokenStore({ secretStore: memoryStore() }).set("x".repeat(4097)),
    /Future Session Token 过长/u
  );
  await assert.rejects(
    () => new MiaoicTokenStore({ secretStore: memoryStore() }).set("bad;cookie"),
    /Miaoic 内部账户标识格式无效/u
  );
});

test("local adapters retain the existing provider-specific files", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-accounts-credential-test-"));
  temporaryRoots.add(root);
  const cases = [
    { factory: createLocalFiveSimTokenStore, fileName: fiveSimFile, key: fiveSimKey },
    { factory: createLocalSms688TokenStore, fileName: sms688File, key: sms688Key },
    { factory: createLocalFutureTokenStore, fileName: futureFile, key: futureKey },
    { factory: createLocalMiaoicTokenStore, fileName: miaoicFile, key: miaoicKey }
  ];

  for (const { factory, fileName, key } of cases) {
    const localStore = factory({ fsPath: root });
    const payload = JSON.stringify({ version: 1, token: `${fileName}-test-token` });
    await localStore.store(key, payload);
    assert.equal(fs.readFileSync(path.join(root, fileName), "utf8"), payload);
  }
});

function memoryStore(values = new Map()) {
  return {
    async get(key) { return values.get(key); },
    async store(key, value) { values.set(key, value); }
  };
}

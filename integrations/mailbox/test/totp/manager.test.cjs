"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  TOTP_CONFIG_KEY,
  TOTP_LINKS_KEY,
  TwoFactorManager
} = require("../../src/totp/manager.cjs");

test("TOTP manager migrates the legacy PAT to the owner-only config file and keeps mailbox links non-sensitive", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mailbox-totp-test-"));
  const configFilePath = path.join(directory, "mailbox-2fauth.json");
  try {
    const metadataStore = createStore();
    const secretStore = createStore();
    await secretStore.store(TOTP_CONFIG_KEY, JSON.stringify({ baseUrl: "http://127.0.0.1:8000", token: "pat-value" }));
    let created = 0;
    const client = {
      baseUrl: "http://127.0.0.1:8000",
      token: "pat-value",
      async listAccounts() {
        return [{ id: "7", service: "OpenAI", account: "one@example.com", otpType: "totp" }];
      },
      async getOtp() {
        return { code: "123456", nextCode: "654321", generatedAt: 100, period: 30 };
      },
      async createAccount() {
        created += 1;
        return { id: "7", service: "OpenAI", account: "one@example.com", otpType: "totp" };
      }
    };
    const manager = new TwoFactorManager({
      metadataStore,
      secretStore,
      configFilePath,
      now: () => 100,
      clientFactory(options) {
        return { ...client, baseUrl: options.baseUrl, token: options.token };
      }
    });

    await manager.load();
    await manager.createAndLink("mailbox:one", { secret: "JBSWY3DPEHPK3PXP", address: "one@example.com" });
    assert.equal(created, 1);
    assert.deepEqual((await manager.getSummary()).links["mailbox:one"], {
      mailboxId: "mailbox:one",
      address: "one@example.com",
      accountId: "7",
      service: "OpenAI",
      account: "one@example.com",
      linkedAt: 100,
      updatedAt: 100
    });

    const state = await manager.queryMailbox("mailbox:one", { address: "one@example.com" });
    assert.equal(state.otp.code, "123456");
    assert.equal(state.account.id, "7");
    assert.doesNotMatch(JSON.stringify(metadataStore.values), /pat-value/u);
    assert.equal(await secretStore.get(TOTP_CONFIG_KEY), undefined);
    assert.match(JSON.stringify(metadataStore.values.get(TOTP_LINKS_KEY)), /mailbox:one/u);

    const fileConfig = JSON.parse(await fs.readFile(configFilePath, "utf8"));
    assert.deepEqual(fileConfig, {
      version: 1,
      baseUrl: "http://127.0.0.1:8000",
      token: "pat-value"
    });
    assert.equal((await fs.stat(configFilePath)).mode & 0o777, 0o600);

    await manager.unlinkMailbox("mailbox:one");
    assert.deepEqual((await manager.getSummary()).links, {});
    assert.equal((await fs.stat(configFilePath)).mode & 0o777, 0o600);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("TOTP manager keeps one current link per mailbox and hides replaced remote entries", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mailbox-totp-test-"));
  const configFilePath = path.join(directory, "mailbox-2fauth.json");
  await fs.writeFile(configFilePath, JSON.stringify({ version: 1, baseUrl: "https://2fa.example.test", token: "pat" }));
  try {
    const metadataStore = createStore();
    const secretStore = createStore();
    const deletedAccountIds = [];
    const manager = new TwoFactorManager({
      metadataStore,
      secretStore,
      configFilePath,
      now: (() => {
        let value = 100;
        return () => value += 1;
      })(),
      clientFactory: (options) => ({
        baseUrl: options.baseUrl,
        token: options.token,
        async listAccounts() {
          return [
            { id: "1", service: "OpenAI", account: "old@example.com", otpType: "totp" },
            { id: "2", service: "OpenAI", account: "current@example.com", otpType: "totp" },
            { id: "3", service: "OpenAI", account: "new@example.com", otpType: "totp" },
            { id: "4", service: "OpenAI", account: "same@example.com", otpType: "totp", createdAt: 100 },
            { id: "9", service: "OpenAI", account: "same@example.com", otpType: "totp", createdAt: 200 }
          ];
        },
        async deleteAccount(accountId) { deletedAccountIds.push(accountId); }
      })
    });

    await manager.load();
    const autoBindings = await manager.autoBindLatestMailboxes([{ id: "mailbox:auto", address: "same@example.com" }]);
    assert.deepEqual(autoBindings, [{ mailboxId: "mailbox:auto", accountId: "9", existing: false }]);
    await manager.linkMailbox("mailbox:one", "1", { address: "one@example.com" });
    await manager.linkMailbox("mailbox:one", "2", { address: "one@example.com" });
    await manager.linkMailbox("mailbox:one", "3", { address: "one@example.com" });

    const state = await manager.getMailboxState("mailbox:one", { address: "one@example.com" });
    assert.equal(state.link.accountId, "3");
    assert.deepEqual(state.accounts.map((account) => account.id), ["3", "4", "9"]);
    assert.equal(state.account.id, "3");
    const storedLink = metadataStore.values.get(TOTP_LINKS_KEY).links.find((link) => link.mailboxId === "mailbox:one");
    assert.deepEqual(storedLink.hiddenAccountIds, ["1", "2"]);
    assert.equal(metadataStore.values.get(TOTP_LINKS_KEY).links.length, 2);
    assert.deepEqual(await manager.deleteRemoteAccount("3"), { accountId: "3", deleted: true });
    assert.deepEqual(deletedAccountIds, ["3"]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

function createStore() {
  const values = new Map();
  return {
    values,
    async get(key) { return values.get(key); },
    async update(key, value) { if (value === undefined) values.delete(key); else values.set(key, structuredClone(value)); },
    async store(key, value) { values.set(key, value); },
    async delete(key) { values.delete(key); }
  };
}

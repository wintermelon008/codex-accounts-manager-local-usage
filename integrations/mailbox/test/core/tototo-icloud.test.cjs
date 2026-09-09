"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  TOTOTO_ICLOUD_BASE_URL,
  TOTOTO_ICLOUD_HOSTNAME,
  TOTOTO_ICLOUD_PROVIDER_ID,
  TototoIcloudProvider
} = require("../../src/core/providers/tototo-icloud.cjs");

const account = {
  address: "discord.tatamis.1y@icloud.com",
  credentials: {
    codeUrl:
      "https://ima4.52dfd.top/api/v1/mailboxes/discord.tatamis.1y@icloud.com/code?key=test-key-value"
  }
};

test("tototo-icloud exposes the provider contract and parses email----URL rows", () => {
  const provider = new TototoIcloudProvider({ fetchImpl: async () => response({}) }).asProvider();

  assert.equal(provider.id, TOTOTO_ICLOUD_PROVIDER_ID);
  assert.equal(provider.displayName, "tototo-icloud");
  assert.deepEqual(provider.capabilities, { history: "latest", maxMessages: 1, manualRenewal: false });
  assert.match(provider.importSchema.placeholder, /^user@example.com----https:\/\/ima4\.52dfd\.top/u);
  assert.deepEqual(provider.parseImport(account.address + "----" + account.credentials.codeUrl), {
    entries: [{ address: account.address, credentials: { codeUrl: account.credentials.codeUrl } }],
    failed: []
  });
  assert.equal(TOTOTO_ICLOUD_HOSTNAME, "ima4.52dfd.top");
  assert.equal(TOTOTO_ICLOUD_BASE_URL, "https://ima4.52dfd.top");
});

test("tototo-icloud queries the supplied URL and normalizes a returned code", async () => {
  const requests = [];
  const provider = new TototoIcloudProvider({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return response({
        success: true,
        code: "123456",
        message: "Use 123456 to continue; source URL: " + account.credentials.codeUrl,
        received_at: "2026-09-09T01:00:00.000Z"
      });
    }
  });

  const result = await provider.query(account);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, account.credentials.codeUrl);
  assert.equal(requests[0].options.method, "GET");
  assert.match(requests[0].options.headers.accept, /application\/json/u);
  assert.equal(result.ok, true);
  assert.equal(result.providerId, TOTOTO_ICLOUD_PROVIDER_ID);
  assert.deepEqual(result.codes, ["123456"]);
  assert.equal(result.messages[0].receivedAt, "2026-09-09T01:00:00.000Z");
  assert.equal(result.messages[0].body, "Use 123456 to continue; source URL: [redacted] 验证码：123456");
  assert.doesNotMatch(JSON.stringify(result), /test-key-value/u);
});

test("tototo-icloud treats the service no_code response as a successful empty query", async () => {
  const provider = new TototoIcloudProvider({
    fetchImpl: async () => response({
      success: false,
      code: "no_code",
      message: "暂未收到验证码",
      retryable: true
    })
  });

  const result = await provider.query(account);

  assert.deepEqual(result, {
    ok: true,
    providerId: TOTOTO_ICLOUD_PROVIDER_ID,
    address: account.address,
    messages: [],
    codes: [],
    fetchedAt: result.fetchedAt
  });
  assert.match(result.fetchedAt, /^\d{4}-\d{2}-\d{2}T/u);
});

test("tototo-icloud rejects unapproved URL rows and keeps HTTP errors safe", async () => {
  const provider = new TototoIcloudProvider({ fetchImpl: async () => response({}) }).asProvider();
  const parsed = provider.parseImport([
    account.address + "----https://example.invalid/api/v1/mailboxes/" + account.address + "/code?key=secret",
    account.address + "----https://ima4.52dfd.top/api/v1/mailboxes/other@example.com/code?key=secret",
    account.address + "----https://ima4.52dfd.top/api/v1/mailboxes/" + account.address + "/code"
  ].join("\n"));

  assert.equal(parsed.entries.length, 0);
  assert.equal(parsed.failed.length, 3);
  assert.doesNotMatch(JSON.stringify(parsed), /secret/u);

  const failed = new TototoIcloudProvider({
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) })
  });
  const result = await failed.query(account);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "http_503");
  assert.doesNotMatch(JSON.stringify(result), /test-key-value/u);
});

function response(data) {
  return { ok: true, status: 200, json: async () => data };
}

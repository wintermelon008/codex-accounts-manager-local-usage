"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { BoyaProvider, BOYA_BASE_URL, BOYA_CODES_PATH } = require("../../src/core/providers/boya.cjs");

const account = {
  address: "person@example.com",
  credentials: { privateToken: "private-token-value" }
};

test("boya exposes the provider contract and parses email----private token rows", () => {
  const provider = new BoyaProvider({ fetchImpl: async () => response({}) }).asProvider();

  assert.equal(provider.id, "boya");
  assert.equal(provider.displayName, "boya");
  assert.deepEqual(provider.capabilities, { history: "latest", maxMessages: 1, manualRenewal: false });
  assert.equal(provider.importSchema.placeholder, "user@example.com----private_token");
  assert.deepEqual(provider.parseImport("person@example.com----private-token-value"), {
    entries: [{ address: "person@example.com", credentials: { privateToken: "private-token-value" } }],
    failed: []
  });
});

test("boya query posts one opaque credential row and normalizes the returned code message", async () => {
  const requests = [];
  const provider = new BoyaProvider({
    fetchImpl: async (url, options) => {
      requests.push({ url, options, body: JSON.parse(options.body) });
      return response({
        ok: true,
        total: 1,
        items: [{
          userEmail: account.address,
          ok: true,
          code: "123456",
          cached: true,
          message: {
            id: "boya-message-id",
            subject: "Your verification code private-token-value",
            receivedDateTime: "2026-08-13T01:00:00.000Z"
          }
        }]
      });
    }
  });

  const result = await provider.query(account);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `${BOYA_BASE_URL}${BOYA_CODES_PATH}`);
  assert.equal(requests[0].options.method, "POST");
  assert.deepEqual(requests[0].body, { text: "person@example.com----private-token-value" });
  assert.equal(result.ok, true);
  assert.equal(result.providerId, "boya");
  assert.deepEqual(result.codes, ["123456"]);
  assert.equal(result.messages[0].subject, "Your verification code [redacted]");
  assert.equal(result.messages[0].receivedAt, "2026-08-13T01:00:00.000Z");
  assert.equal(result.messages[0].body, "验证码：123456");
  assert.match(result.messages[0].id, /^[a-f0-9]{64}$/u);
});

test("boya redacts a private token if an upstream message field unexpectedly echoes it", async () => {
  const provider = new BoyaProvider({
    fetchImpl: async () => response({
      ok: true,
      items: [{
        userEmail: account.address,
        ok: true,
        code: "123456",
        message: { subject: "token private-token-value", bodyPreview: "private-token-value 123456" }
      }]
    })
  });

  const result = await provider.query(account);

  assert.equal(result.ok, true);
  assert.doesNotMatch(JSON.stringify(result), /private-token-value/u);
  assert.match(result.messages[0].body, /\[redacted\]/u);
});

test("boya maps account failures to safe errors without returning private token text", async () => {
  const provider = new BoyaProvider({
    fetchImpl: async () => response({
      ok: true,
      total: 1,
      items: [{ userEmail: account.address, ok: false, error: "邮箱或私有令牌不正确: private-token-value" }]
    })
  });

  const result = await provider.query(account);

  assert.equal(result.ok, false);
  assert.equal(result.error.stage, "auth");
  assert.equal(result.error.code, "invalid_credentials");
  assert.doesNotMatch(JSON.stringify(result), /private-token-value/u);
});

test("boya rejects malformed rows without echoing credential material", () => {
  const provider = new BoyaProvider({ fetchImpl: async () => response({}) }).asProvider();
  const result = provider.parseImport([
    "person@example.com----",
    "not-an-email----secret-value"
  ].join("\n"));

  assert.equal(result.entries.length, 0);
  assert.equal(result.failed.length, 2);
  assert.doesNotMatch(JSON.stringify(result), /secret-value|extra/u);
});

test("boya preserves additional delimiter characters inside the private token", () => {
  const provider = new BoyaProvider({ fetchImpl: async () => response({}) }).asProvider();

  assert.deepEqual(provider.parseImport("person@example.com----token----with----delimiters"), {
    entries: [{ address: "person@example.com", credentials: { privateToken: "token----with----delimiters" } }],
    failed: []
  });
});

test("boya maps HTTP failures to the shared safe error shape", async () => {
  const provider = new BoyaProvider({
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) })
  });

  const result = await provider.query(account);

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "http_503");
  assert.doesNotMatch(JSON.stringify(result), /private-token-value/u);
});

function response(data) {
  return { ok: true, status: 200, json: async () => data };
}

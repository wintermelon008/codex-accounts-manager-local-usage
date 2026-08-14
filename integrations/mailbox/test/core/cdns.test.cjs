"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  CDNS_BASE_URL,
  CDNS_RECEIVE_PATH,
  CDNS_SOURCE_RESOLVE_PATH,
  CdnsProvider
} = require("../../src/core/providers/cdns.cjs");

const account = {
  address: "person@example.com",
  credentials: {
    email: "person@example.com",
    password: "password-value",
    receiveToken: "receive-token-value",
    publicRef: "public-ref-value"
  }
};

test("cdns exposes the provider contract and parses four-segment rows", () => {
  const provider = new CdnsProvider({ fetchImpl: async () => response({}) }).asProvider();

  assert.equal(provider.id, "cdns");
  assert.equal(provider.displayName, "cdns");
  assert.deepEqual(provider.capabilities, { history: "latest", maxMessages: 1, manualRenewal: false });
  assert.equal(provider.importSchema.placeholder, "email@example.com----password----receive_token----public_ref");
  assert.deepEqual(provider.parseImport(
    "person@example.com----password-value----receive-token-value----public-ref-value"
  ), {
    entries: [{
      address: "person@example.com",
      credentials: {
        email: "person@example.com",
        password: "password-value",
        receiveToken: "receive-token-value",
        publicRef: "public-ref-value"
      }
    }],
    failed: []
  });
});

test("cdns resolves the account source before querying the latest verification message", async () => {
  const requests = [];
  const provider = new CdnsProvider({
    baseUrl: "https://cdns.example.invalid/",
    fetchImpl: async (url, options) => {
      requests.push({ url, options, body: JSON.parse(options.body) });
      if (url.endsWith(CDNS_SOURCE_RESOLVE_PATH)) {
        return response({
          items: [{ index: 0, matched: true, source_upstream_key: "source-key" }],
          source_errors: {}
        });
      }
      return response({
        success: true,
        email: account.address,
        subject: "Your verification code",
        code: "123456",
        message: "Use 123456 to continue",
        received_at: "2026-08-13T01:00:00.000Z"
      });
    }
  });

  const result = await provider.query(account);

  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, `https://cdns.example.invalid${CDNS_SOURCE_RESOLVE_PATH}`);
  assert.deepEqual(requests[0].body, {
    accounts: [{ email: account.address, public_ref: "public-ref-value" }]
  });
  assert.equal(requests[1].url, `https://cdns.example.invalid${CDNS_RECEIVE_PATH}`);
  assert.deepEqual(requests[1].body, {
    email: account.address,
    password: "password-value",
    receive_token: "receive-token-value",
    public_ref: "public-ref-value",
    source_upstream_key: "source-key"
  });
  assert.equal(result.ok, true);
  assert.equal(result.providerId, "cdns");
  assert.deepEqual(result.codes, ["123456"]);
  assert.equal(result.messages[0].subject, "Your verification code");
  assert.equal(result.messages[0].receivedAt, "2026-08-13T01:00:00.000Z");
  assert.equal(result.messages[0].body, "Use 123456 to continue 验证码：123456");
  assert.match(result.messages[0].id, /^[a-f0-9]{64}$/u);
  assert.equal(CDNS_BASE_URL, "https://ai.cdns.ccwu.cc");
});

test("cdns redacts credentials from returned message fields", async () => {
  const provider = new CdnsProvider({
    fetchImpl: async (url) => url.endsWith(CDNS_SOURCE_RESOLVE_PATH)
      ? response({ items: [{ index: 0, matched: true, source_upstream_key: "source-key" }] })
      : response({
        success: true,
        subject: "password-value receive-token-value public-ref-value",
        message: "password-value receive-token-value public-ref-value 123456",
        code: "123456"
      })
  });

  const result = await provider.query(account);

  assert.equal(result.ok, true);
  assert.doesNotMatch(JSON.stringify(result), /password-value|receive-token-value|public-ref-value/u);
  assert.match(result.messages[0].subject, /\[redacted\]/u);
});

test("cdns maps an unmatched source to a safe non-retryable error", async () => {
  let receiveCalled = false;
  const provider = new CdnsProvider({
    fetchImpl: async (url) => {
      if (url.endsWith(CDNS_SOURCE_RESOLVE_PATH)) {
        return response({
          items: [{ index: 0, matched: false, error: "account_source_not_found" }]
        });
      }
      receiveCalled = true;
      return response({ success: true, code: "123456" });
    }
  });

  const result = await provider.query(account);

  assert.equal(receiveCalled, false);
  assert.equal(result.ok, false);
  assert.equal(result.error.stage, "source");
  assert.equal(result.error.code, "account_source_not_found");
  assert.equal(result.error.retryable, false);
  assert.doesNotMatch(JSON.stringify(result), /password-value|receive-token-value|public-ref-value/u);
});

test("cdns keeps provider HTTP failures safe and rejects malformed rows", async () => {
  const provider = new CdnsProvider({
    fetchImpl: async (url) => url.endsWith(CDNS_SOURCE_RESOLVE_PATH)
      ? response({ items: [{ index: 0, matched: true, source_upstream_key: "source-key" }] })
      : { ok: false, status: 503, json: async () => ({}) }
  }).asProvider();

  const result = await provider.query(account);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "http_503");
  assert.doesNotMatch(JSON.stringify(result), /password-value|receive-token-value|public-ref-value/u);

  const parsed = provider.parseImport([
    "person@example.com----password-value----receive-token-value----",
    "not-an-email----secret-value"
  ].join("\n"));
  assert.equal(parsed.entries.length, 0);
  assert.equal(parsed.failed.length, 2);
  assert.doesNotMatch(JSON.stringify(parsed), /secret-value/u);
});

function response(data) {
  return { ok: true, status: 200, json: async () => data };
}

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { Eight92Provider } = require("../../src/core/providers/eight92.cjs");

const account = {
  address: "person@example.com",
  credentials: {
    email: "person@example.com",
    password: "password",
    clientId: "client-id",
    refreshToken: "old-refresh-token"
  }
};

test("provider exposes generic capabilities and parses its own import format", () => {
  const provider = new Eight92Provider({ fetchImpl: async () => response({}) }).asProvider();
  assert.equal(provider.id, "8t92");
  assert.equal(provider.displayName, "tototo-outlook");
  assert.equal(provider.capabilities.history, "recent");
  assert.equal(provider.capabilities.manualRenewal, false);
  assert.deepEqual(provider.parseImport("person@example.com----password----client-id----refresh-token"), {
    entries: [{
      address: "person@example.com",
      credentials: { email: "person@example.com", password: "password", clientId: "client-id", refreshToken: "refresh-token" }
    }],
    failed: []
  });
});

test("query sends the provider contract and normalizes messages with complete sender addresses", async () => {
  const requests = [];
  const provider = new Eight92Provider({
    baseUrl: "https://8t92.example.invalid/",
    fetchImpl: async (url, options) => {
      requests.push({ url, options, body: JSON.parse(options.body) });
      return response({
        ok: true,
        provider: "graph",
        mailbox: "INBOX",
        mode: "all",
        fallbackMode: "",
        count: 1,
        fetchedAt: "2026-08-13T01:00:01.000Z",
        mails: [{
          id: "message-id",
          subject: "Your verification code is 123456",
          from: { emailAddress: { address: "sender@example.com" } },
          receivedDateTime: "2026-08-13T01:00:00.000Z",
          body: { content: "Use 123456 to continue", contentType: "html" }
        }]
      });
    }
  });

  const result = await provider.query(account, { maxMessages: 80 });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://8t92.example.invalid/api/outlook/query");
  assert.deepEqual(requests[0].body, {
    email: "person@example.com",
    password: "password",
    client_id: "client-id",
    refresh_token: "old-refresh-token",
    mailbox: "INBOX",
    mode: "all",
    top: 50
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.codes, ["123456"]);
  assert.equal(result.address, account.address);
  assert.equal(result.messages[0].from, "sender@example.com");
  assert.equal(result.messages[0].subject, "Your verification code is 123456");
  assert.match(result.messages[0].id, /^[a-f0-9]{64}$/u);
});

test("query isolates NLoop failures and does not return upstream credential text", async () => {
  const provider = new Eight92Provider({
    fetchImpl: async () => response({
      ok: false,
      error: "refresh_token=super-secret-value"
    })
  });

  const result = await provider.query(account);
  assert.equal(result.ok, false);
  assert.equal(result.error.stage, "provider");
  assert.equal(result.error.code, "nloop_query_failed");
  assert.doesNotMatch(result.error.message, /super-secret-value/u);
  assert.equal(result.messages.length, 0);
});

test("NLoop query keeps HTTP failures safe", async () => {
  const failed = new Eight92Provider({
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) })
  });
  const failedResult = await failed.query(account);
  assert.equal(failedResult.error.code, "http_503");
  assert.doesNotMatch(failedResult.error.message, /old-refresh-token/u);
});

function response(data) {
  return { ok: true, status: 200, json: async () => data };
}

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
  assert.equal(provider.capabilities.history, "recent");
  assert.equal(provider.capabilities.manualRenewal, true);
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
        results: [{
          email: account.address,
          ok: true,
          messages: [{
            id: "message-id",
            subject: "Your verification code is 123456",
            from: { emailAddress: { address: "sender@example.com" } },
            receivedDateTime: "2026-08-13T01:00:00.000Z",
            body: { content: "Use 123456 to continue", contentType: "html" }
          }]
        }]
      });
    }
  });

  const result = await provider.query(account, { maxMessages: 80 });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://8t92.example.invalid/api/fetch-mails");
  assert.equal(requests[0].body.lines, "person@example.com----password----client-id----old-refresh-token");
  assert.deepEqual(requests[0].body.options, {
    tokenKind: "refresh_token",
    redirectUri: "",
    folderScope: "inbox",
    maxMessages: 50,
    bodyContent: "html",
    includeBody: true,
    includeHeaders: true
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.codes, ["123456"]);
  assert.equal(result.address, account.address);
  assert.equal(result.messages[0].from, "sender@example.com");
  assert.equal(result.messages[0].subject, "Your verification code is 123456");
  assert.match(result.messages[0].id, /^[a-f0-9]{64}$/u);
});

test("query isolates provider failures and does not return upstream credential text", async () => {
  const provider = new Eight92Provider({
    fetchImpl: async () => response({
      ok: false,
      results: [{
        email: account.address,
        ok: false,
        errors: [{ stage: "token", code: "AADSTS7000012", message: "refreshToken=super-secret-value" }]
      }]
    })
  });

  const result = await provider.query(account);
  assert.equal(result.ok, false);
  assert.equal(result.error.stage, "token");
  assert.equal(result.error.code, "AADSTS7000012");
  assert.doesNotMatch(result.error.message, /super-secret-value/u);
  assert.equal(result.messages.length, 0);
});

test("manual renewal only returns updated credentials when the provider changes them", async () => {
  const calls = [];
  const provider = new Eight92Provider({
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return response({
        ok: true,
        updatedLines: ["person@example.com----password----client-id----new-refresh-token"],
        results: [{
          email: account.address,
          ok: true,
          refreshTokenChanged: true,
          updatedLine: "person@example.com----password----client-id----new-refresh-token"
        }]
      });
    }
  });

  const result = await provider.renew(account);
  assert.equal(calls[0].url, "https://8t92.cc/api/refresh-tokens");
  assert.deepEqual(calls[0].body, {
    lines: "person@example.com----password----client-id----old-refresh-token"
  });
  assert.equal(result.status, "updated");
  assert.equal(result.account.credentials.refreshToken, "new-refresh-token");
});

test("unchanged renewal preserves the original credentials and failed HTTP requests are safe", async () => {
  const unchanged = new Eight92Provider({
    fetchImpl: async () => response({
      ok: true,
      results: [{ email: account.address, ok: true, refreshTokenChanged: false }]
    })
  });
  const unchangedResult = await unchanged.renew(account);
  assert.equal(unchangedResult.status, "unchanged");
  assert.equal(unchangedResult.account.credentials.refreshToken, account.credentials.refreshToken);

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

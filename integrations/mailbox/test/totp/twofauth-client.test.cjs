"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  TwoFAuthClient,
  createTotpUri,
  normalizeBaseUrl,
  normalizeSecret
} = require("../../src/totp/twofauth-client.cjs");

test("2FAuth client lists sanitized accounts with bearer authentication", async () => {
  const calls = [];
  const client = new TwoFAuthClient({
    baseUrl: "http://127.0.0.1:8000/",
    token: "pat-secret",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(200, [{ id: 7, service: "OpenAI", account: "one@example.com", secret: "DO_NOT_RETURN" }]);
    }
  });

  await assert.doesNotReject(async () => client.listAccounts());
  const accounts = await client.listAccounts();
  assert.deepEqual(accounts, [{
    id: "7",
    service: "OpenAI",
    account: "one@example.com",
    otpType: "",
    digits: undefined,
    algorithm: "",
    period: undefined,
    counter: undefined
  }]);
  assert.equal(calls.at(-1).url, "http://127.0.0.1:8000/api/v1/twofaccounts");
  assert.equal(calls.at(-1).options.headers.authorization, "Bearer pat-secret");
  assert.equal("secret" in accounts[0], false);
});

test("2FAuth client gets an OTP and creates an account from a URI", async () => {
  const calls = [];
  const client = new TwoFAuthClient({
    baseUrl: "https://2fa.example.test",
    token: "pat",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return calls.length === 1
        ? response(200, { password: "123456", next_password: "654321", generated_at: 10, period: 30 })
        : response(201, { id: 9, service: "OpenAI", account: "two@example.com" });
    }
  });

  assert.deepEqual(await client.getOtp("9"), {
    code: "123456",
    nextCode: "654321",
    generatedAt: 10,
    period: 30
  });
  const uri = createTotpUri({ secret: "JBSWY3DPEHPK3PXP", account: "two@example.com" });
  assert.equal((await client.createAccount({ uri })).id, "9");
  assert.equal(calls[0].url, "https://2fa.example.test/api/v1/twofaccounts/9/otp");
  assert.deepEqual(JSON.parse(calls[1].options.body), { uri });
});

test("2FAuth client deletes an account through the authenticated DELETE endpoint", async () => {
  const calls = [];
  const client = new TwoFAuthClient({
    baseUrl: "https://2fa.example.test",
    token: "pat",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(204, undefined);
    }
  });

  assert.equal(await client.deleteAccount("9"), true);
  assert.equal(calls[0].url, "https://2fa.example.test/api/v1/twofaccounts/9");
  assert.equal(calls[0].options.method, "DELETE");
});

test("2FAuth client validates local connection inputs and hides response bodies on errors", async () => {
  assert.equal(normalizeBaseUrl("https://2fa.example.test///"), "https://2fa.example.test");
  assert.equal(normalizeSecret(" jbsw-y3dp ehpk3pxp "), "JBSWY3DPEHPK3PXP");
  await assert.rejects(
    () => new TwoFAuthClient({ baseUrl: "https://2fa.example.test", token: "pat", fetchImpl: async () => response(401, { secret: "must-not-leak" }) }).listAccounts(),
    /访问令牌无效/u
  );
  assert.throws(() => normalizeBaseUrl("file:///tmp/2fa"), /http\(s\)/u);
});

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return payload === undefined ? "" : JSON.stringify(payload); }
  };
}

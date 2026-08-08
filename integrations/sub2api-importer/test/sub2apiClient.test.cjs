"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { IMPORT_PATH, Sub2ApiImportError, submitSub2ApiImport } = require("../src/sub2apiClient.cjs");

const configuration = { adminBaseUrl: "https://gateway.example.invalid", adminApiKey: "private-admin-api-key" };

test("submits only a canonical Sub2API payload to the documented import endpoint", async () => {
  let request;
  const result = await submitSub2ApiImport(configuration, payload(), {
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ code: 0, data: { account_created: 2, account_failed: 1, proxy_reused: 1 } }), { status: 200 });
    }
  });
  assert.equal(request.url, `${configuration.adminBaseUrl}${IMPORT_PATH}`);
  assert.equal(request.options.headers["x-api-key"], "private-admin-api-key");
  assert.equal(request.options.headers.authorization, undefined);
  assert.deepEqual(JSON.parse(request.options.body), { data: payload(), skip_default_group_bind: true });
  assert.deepEqual(result, { statusCode: 200, accountCreated: 2, accountFailed: 1, proxyCreated: 0, proxyReused: 1, proxyFailed: 0 });
});

test("fails closed without retaining server error text", async () => {
  await assert.rejects(
    submitSub2ApiImport(configuration, payload(), {
      fetchImpl: async () => new Response(JSON.stringify({ code: 4031, message: "do not retain this remote message" }), { status: 200 })
    }),
    (error) => error instanceof Sub2ApiImportError && error.kind === "remoteRejected" && !error.message.includes("remote message")
  );
  await assert.rejects(submitSub2ApiImport(configuration, { type: "other" }), (error) => error instanceof Sub2ApiImportError && error.kind === "invalidPayload");
});

function payload() {
  return { type: "sub2api-data", version: 1, exported_at: "2026-01-01T00:00:00.000Z", proxies: [], accounts: [{ name: "test" }] };
}

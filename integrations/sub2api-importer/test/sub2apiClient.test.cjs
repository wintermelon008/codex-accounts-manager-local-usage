"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { IMPORT_PATH, Sub2ApiImportError, submitSub2ApiImport } = require("../src/sub2apiClient.cjs");

const configuration = { adminBaseUrl: "https://gateway.example.invalid", adminToken: "private-admin-token" };

test("submits only a canonical Sub2API payload to the documented import endpoint", async () => {
  let request;
  const result = await submitSub2ApiImport(configuration, payload(), {
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ code: 0, data: { account_created: 2, account_failed: 1, proxy_reused: 1 } }), { status: 200 });
    }
  });
  assert.equal(request.url, `${configuration.adminBaseUrl}${IMPORT_PATH}`);
  assert.equal(request.options.headers.authorization, "Bearer private-admin-token");
  assert.equal(request.options.headers["x-admin-ui-request"], "1");
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

test("refreshes an expired administrator access token once and persists a rotated refresh token", async () => {
  const requests = [];
  const saved = [];
  let imports = 0;
  const result = await submitSub2ApiImport(
    {
      adminBaseUrl: configuration.adminBaseUrl,
      adminToken: "expired-access-token",
      adminRefreshToken: "initial-refresh-token",
      adminSessionStateFile: "/private/state/session.json"
    },
    payload(),
    {
      loadRefreshToken: async () => undefined,
      saveRefreshToken: async (file, token) => saved.push({ file, token }),
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        if (url.endsWith(IMPORT_PATH)) {
          imports += 1;
          if (imports === 1) return new Response(JSON.stringify({ code: "TOKEN_EXPIRED" }), { status: 401 });
          return new Response(JSON.stringify({ code: 0, data: { account_created: 1 } }), { status: 200 });
        }
        assert.equal(url, `${configuration.adminBaseUrl}/api/v1/auth/refresh`);
        assert.deepEqual(JSON.parse(options.body), { refresh_token: "initial-refresh-token" });
        return new Response(JSON.stringify({ code: 0, data: { access_token: "fresh-access-token", refresh_token: "rotated-refresh-token" } }), { status: 200 });
      }
    }
  );
  assert.equal(imports, 2);
  assert.equal(requests.filter((request) => request.url.endsWith(IMPORT_PATH))[0].options.headers.authorization, "Bearer expired-access-token");
  assert.equal(requests.filter((request) => request.url.endsWith(IMPORT_PATH))[1].options.headers.authorization, "Bearer fresh-access-token");
  assert.deepEqual(saved, [{ file: "/private/state/session.json", token: "rotated-refresh-token" }]);
  assert.equal(result.accountCreated, 1);
});

test("does not retry an expired access token when no private refresh token is configured", async () => {
  await assert.rejects(
    submitSub2ApiImport(
      { adminBaseUrl: configuration.adminBaseUrl, adminToken: "expired-access-token" },
      payload(),
      {
        loadRefreshToken: async () => undefined,
        fetchImpl: async () => new Response(JSON.stringify({ code: "TOKEN_EXPIRED" }), { status: 401 })
      }
    ),
    (error) => error instanceof Sub2ApiImportError && error.kind === "remoteRejected" && error.statusCode === 401
  );
});

test("prefers a privately persisted rotated refresh token after a service restart", async () => {
  let refreshRequest;
  await submitSub2ApiImport(
    {
      adminBaseUrl: configuration.adminBaseUrl,
      adminToken: "expired-access-token",
      adminRefreshToken: "stale-refresh-token",
      adminSessionStateFile: "/private/state/session.json"
    },
    payload(),
    {
      loadRefreshToken: async () => "persisted-rotated-refresh-token",
      fetchImpl: async (url, options) => {
        if (url.endsWith(IMPORT_PATH) && options.headers.authorization === "Bearer expired-access-token") {
          return new Response(JSON.stringify({ code: "TOKEN_EXPIRED" }), { status: 401 });
        }
        if (url.endsWith("/api/v1/auth/refresh")) {
          refreshRequest = JSON.parse(options.body);
          return new Response(JSON.stringify({ code: 0, data: { access_token: "fresh-access-token" } }), { status: 200 });
        }
        return new Response(JSON.stringify({ code: 0, data: { account_created: 1 } }), { status: 200 });
      }
    }
  );
  assert.deepEqual(refreshRequest, { refresh_token: "persisted-rotated-refresh-token" });
});

function payload() {
  return { type: "sub2api-data", version: 1, exported_at: "2026-01-01T00:00:00.000Z", proxies: [], accounts: [{ name: "test" }] };
}

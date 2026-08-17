"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { BugTeamApiError, BugTeamClient, normalizeBaseUrl } = require("../src/api/client.cjs");
const { selectOneHourProduct } = require("../src/core/product.cjs");
const { normalizeSub2Bundle } = require("../src/core/sub2.cjs");

test("BugTeam client sends the customer token and preserves the idempotency key", async () => {
  const requests = [];
  const client = new BugTeamClient({
    token: "cfk_test_token",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return jsonResponse({ order_id: "ord-1", state: "waiting_inventory" }, 201);
    },
    baseUrl: "https://bugteam.example.test"
  });

  await client.createPickupOrder({ product: "oauth_1h", quantity: 1, idempotencyKey: "retry-key" });
  assert.equal(requests[0].options.headers.get("X-Customer-Token"), "cfk_test_token");
  assert.equal(requests[0].options.headers.get("Idempotency-Key"), "retry-key");
  assert.equal(JSON.parse(requests[0].options.body).product, "oauth_1h");
});

test("BugTeam client reads dispatch shelves and includes the selected bucket in the order", async () => {
  const requests = [];
  const client = new BugTeamClient({
    token: "cfk_test_token",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.includes("/shelves?")) return jsonResponse({ buckets: [{ bucket_start: "2026-08-17T06:10:00Z" }] });
      return jsonResponse({ order_id: "ord-2", state: "waiting_inventory" }, 201);
    },
    baseUrl: "https://bugteam.example.test"
  });

  const shelves = await client.getInventoryShelves("oauth_1h");
  await client.getInventory("oauth_1h", 2, "2026-08-17T06:10:00Z");
  await client.createPickupOrder({
    product: "oauth_1h",
    quantity: 2,
    idempotencyKey: "shelf-key",
    expiryBucketStart: "2026-08-17T06:10:00Z"
  });

  assert.equal(shelves.buckets[0].bucket_start, "2026-08-17T06:10:00Z");
  assert.match(requests[0].url, /\/api\/customer\/inventory\/shelves\?product=oauth_1h/u);
  assert.equal(new URL(requests[1].url).searchParams.get("expiry_bucket_start"), "2026-08-17T06:10:00Z");
  assert.equal(JSON.parse(requests[2].options.body).expiry_bucket_start, "2026-08-17T06:10:00Z");
});

test("BugTeam API base URLs require HTTPS except for local HTTP development", () => {
  assert.equal(normalizeBaseUrl("http://127.0.0.1:4310"), "http://127.0.0.1:4310");
  assert.throws(() => normalizeBaseUrl("http://bugteam.example.test"), /HTTPS/u);
  assert.throws(() => normalizeBaseUrl("file://localhost/tmp/bugteam"), /HTTPS/u);
});

test("BugTeam errors do not echo token material", async () => {
  const client = new BugTeamClient({
    token: "cfk_secret_token_value",
    fetchImpl: async () => jsonResponse({ code: "insufficient_balance", message: "cfk_secret_token_value" }, 402),
    baseUrl: "https://bugteam.example.test"
  });
  await assert.rejects(
    client.getBalance(),
    (error) => error instanceof BugTeamApiError && error.status === 402 && !error.message.includes("cfk_secret_token_value")
  );
});

test("one-hour product selection uses the catalog billing duration", () => {
  const product = selectOneHourProduct([
    { code: "oauth_30d", name: "30d", billing_base_seconds: 2_592_000, price_fen: 300 },
    { code: "oauth_1h", name: "1h", billing_base_seconds: 3600, price_fen: 300 }
  ]);
  assert.equal(product.code, "oauth_1h");
  assert.equal(product.billingBaseSeconds, 3600);
});

test("Sub2 wrapper is reduced to the Manager shared account contract", () => {
  const accounts = normalizeSub2Bundle({
    exported_at: "2026-08-17T00:00:00.000Z",
    proxies: [],
    accounts: [
      {
        email: "one@example.test",
        account_id: "acct-1",
        tokens: { id_token: "id-token", access_token: "access-token", refresh_token: "refresh-token" }
      }
    ]
  });
  assert.deepEqual(accounts[0], {
    id: "acct-1",
    email: "one@example.test",
    auth_mode: "oauth",
    user_id: undefined,
    plan_type: undefined,
    account_id: "acct-1",
    organization_id: undefined,
    account_name: undefined,
    account_structure: undefined,
    added_via: "bugteam",
    subscription_active_until: null,
    tokens: {
      id_token: "id-token",
      access_token: "access-token",
      refresh_token: "refresh-token",
      account_id: "acct-1"
    }
  });
});

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

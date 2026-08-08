"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { fetchSub2ApiGatewayInventory } = require("../src/observer.cjs");

test("inventory observer aggregates read-only windows without returning account data", async () => {
  const requests = [];
  const result = await fetchSub2ApiGatewayInventory(
    { adminBaseUrl: "https://gateway.example.invalid", group: "default" },
    "observer-key",
    {
      requestJson: async (url, headers) => {
        const parsed = new URL(url);
        requests.push({ path: `${parsed.pathname}${parsed.search}`, apiKey: headers["x-api-key"] });
        if (parsed.pathname.endsWith("/groups/all")) return { data: [{ id: 7, name: "default" }] };
        if (parsed.pathname.endsWith("/accounts")) return { data: { items: [{ id: 11, status: "normal" }, { id: 12, status: "disabled" }] } };
        if (parsed.pathname.endsWith("/11/quota")) {
          return { data: { rate_limit: { primary_window: { used_percent: 25 }, secondary_window: { used_percent: 50 } } } };
        }
        throw new Error("unexpected request");
      }
    }
  );

  assert.deepEqual(result.fiveHour, {
    accountCount: 1,
    remainingUnits: 0.75,
    capacityUnits: 1,
    remainingPercent: 75
  });
  assert.equal(result.weekly.remainingPercent, 50);
  assert.equal(result.eligibleAccountCount, 1);
  assert.equal(result.observedAccountCount, 1);
  assert.equal(Object.hasOwn(result, "accounts"), false);
  assert.equal(Object.hasOwn(result, "accountIds"), false);
  assert.deepEqual(requests.map((request) => request.path), [
    "/api/v1/admin/groups/all?platform=openai",
    "/api/v1/admin/accounts?platform=openai&group=7&page=1&page_size=200",
    "/api/v1/admin/openai/accounts/11/quota"
  ]);
  assert.ok(requests.every((request) => request.apiKey === "observer-key"));
});

test("inventory observer fails closed when every eligible quota window is unreadable", async () => {
  await assert.rejects(
    fetchSub2ApiGatewayInventory(
      { adminBaseUrl: "https://gateway.example.invalid", group: "default" },
      "observer-key",
      {
        requestJson: async (url) => {
          if (url.endsWith("groups/all?platform=openai")) return { data: [{ id: 1, name: "default" }] };
          if (url.includes("/accounts?")) return { data: [{ id: 1, status: "normal" }] };
          throw new Error("forbidden");
        }
      }
    ),
    /could not read/u
  );
});
